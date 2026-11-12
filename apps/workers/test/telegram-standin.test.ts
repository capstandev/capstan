// Telegram ops alerts end to end against a stand-in Bot API (ops/alerts/telegram-standin.ts). Every glossary cause
// goes through the real worker path (runOpsAlerts: Redis durable list when REDIS_URL is set, else the events option),
// then sendOpsAlert, then HTTP to the stand-in. ALERTS_ARMED is on only inside this file's env objects.
// Proves: every cause fires once, dedupe inside the 30 minute window, long text splits, a 429 is retried after its
// retry_after, one failed send does not drop the others, and nothing posts when unarmed.
import { createRedis, logger, type JobDeps, type Redis } from "@capstan/core";
import { CAUSES, emitOpsEvent, loadGlossary, MAX_ALERT_CHARS, memoryDedupe, OPS_ALERT_LIST, redisDedupe, sendOpsAlert, TelegramSendError, toOpsAlert, type DedupeStore, type OpsEvent } from "@capstan/telemetry";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTelegramStandin, type TelegramStandin } from "../../../ops/alerts/telegram-standin";
import { resetOpsAlertsState, runOpsAlerts, stopOpsAlertsSubscriber } from "../src/jobs/ops-alerts.job";

const TOKEN = "123456789:" + "StandinOnlyTokenNotRealAAAAAAAA"; // fake: the stand-in only checks the shape of the path
const CHAT = "-1009876543210";
const quiet = logger("t", { sink: () => {} });
const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const REDIS_URL = process.env.REDIS_URL;

let tg: TelegramStandin;
let dir: string;
let redis: Redis | null = null;
let now = T0;
let dedupe: DedupeStore;
let run = 0;

const armedEnv = (extra: Record<string, string> = {}) => ({ ALERTS_ARMED: "1", ALERTS_TOKEN_FILE: join(dir, "token"), ALERTS_CHAT_ID: CHAT, ALERTS_TELEGRAM_API: tg.url, ...extra });
const deps = (): JobDeps => ({ db: null, redis, cache: null, log: quiet, now: () => new Date(now) });

/** Put events through the worker the way production does: onto the Redis list, then one worker run. */
async function deliver(events: OpsEvent[], env: Record<string, string | undefined>, extra: { sleep?: (ms: number) => Promise<void> } = {}) {
  if (redis) {
    for (const e of events) await emitOpsEvent(redis, e, new Date(now));
    await Bun.sleep(150); // let the channel copies land first, as they do between 15 s runs
    return runOpsAlerts(deps(), { env, hl: null, dedupe, ...extra });
  }
  return runOpsAlerts(deps(), { env, hl: null, dedupe, events, ...extra });
}

beforeAll(async () => {
  tg = startTelegramStandin({ port: Number(process.env.TELEGRAM_STANDIN_PORT ?? 0) });
  dir = mkdtempSync(join(tmpdir(), "capstan-tg-standin-"));
  writeFileSync(join(dir, "token"), TOKEN, { mode: 0o600 });
  if (REDIS_URL) redis = createRedis(REDIS_URL);
});
afterAll(async () => {
  tg.stop();
  await stopOpsAlertsSubscriber();
  if (redis) {
    await redis.del(OPS_ALERT_LIST);
    await redis.quit();
  }
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  tg.reset();
  resetOpsAlertsState();
  now = T0;
  run++;
  // a fresh dedupe space per test; with Redis it is the real SET NX PX store under a test prefix
  dedupe = redis ? redisDedupe(redis, `capstan:test:tg-standin:${process.pid}:${run}:`) : memoryDedupe();
  if (redis) await redis.del(OPS_ALERT_LIST);
  // the builder check runs once per 10 minutes on the first run; keep it from adding events
  await runOpsAlerts(deps(), { env: {}, hl: null, aster: null, dedupe, events: [] });
});

describe(`telegram stand-in (${REDIS_URL ? "Redis durable list" : "events option, no Redis"})`, () => {
  test("the glossary and the code list the same causes", () => {
    expect([...loadGlossary().keys()].sort()).toEqual(Object.keys(CAUSES).sort());
  });

  test("every cause fires once, as one plain message to the group", async () => {
    const causes = Object.keys(CAUSES).sort();
    const r = await deliver(causes.map((kind) => ({ kind, detail: { venue: "hl" } })), armedEnv());
    expect(r.map((x) => `${x.cause}:${x.result}`).sort()).toEqual(causes.map((c) => `${c}:sent`));
    const got = tg.delivered("sendMessage");
    expect(got.length).toBe(causes.length);
    const sev = loadGlossary();
    for (const c of causes) {
      const mine = got.filter((m) => m.text.split("\n")[0]!.endsWith(` ${c}`));
      expect(mine.length).toBe(1);
      const m = mine[0]!;
      expect(m.chatId).toBe(CHAT);
      expect(m.tokenLength).toBe(TOKEN.length);
      expect(m.text.split("\n")[0]!.startsWith(`[${sev.get(c)!.severity.toUpperCase()}]`)).toBeTrue();
      for (const part of ["What happened: ", "Who is affected: ", "What was done: ", "What is next: ", `Glossary: ops/alerts/GLOSSARY.md#${c}`]) expect(m.text).toContain(part);
      expect(m.text.length).toBeLessThanOrEqual(MAX_ALERT_CHARS);
    }
    expect(tg.calls.filter((c) => c.method === "sendPhoto").length).toBe(0); // no worker path posts a photo
  });

  test("an unknown kind still reaches the group, as ops.unknown_event", async () => {
    const r = await deliver([{ kind: "made.up_kind" }], armedEnv());
    expect(r).toEqual([{ cause: "ops.unknown_event", result: "sent" }]);
    expect(tg.delivered()[0]!.text).toContain("kind made.up_kind");
  });

  test("dedupe: the same alert twice inside the window sends once", async () => {
    const ev = { kind: "governor.above_90", detail: { budget: "hl-ip", usedPct: 93 } };
    expect((await deliver([ev, { ...ev }], armedEnv())).map((x) => x.result)).toEqual(["sent", "deduped"]);
    now += 29 * 60_000;
    expect((await deliver([{ ...ev }], armedEnv())).map((x) => x.result)).toEqual(["deduped"]);
    expect(tg.delivered().length).toBe(1);
    // another cause is not held back by the first
    expect((await deliver([{ kind: "gas.low" }], armedEnv())).map((x) => x.result)).toEqual(["sent"]);
    expect(tg.delivered().length).toBe(2);
  });

  test.skipIf(!!REDIS_URL)("dedupe: after the 30 minute window the same cause sends again", async () => {
    const ev = { kind: "backup.failed", detail: { step: "dump" } };
    await deliver([ev], armedEnv());
    now += 31 * 60_000;
    expect((await deliver([ev], armedEnv())).map((x) => x.result)).toEqual(["sent"]);
    expect(tg.delivered().length).toBe(2);
  });

  test("long text splits into numbered parts that each fit, and nothing is lost", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(3, "0")} of the read error`);
    const r = await deliver([{ kind: "canary.read_failed", detail: { venue: "hl", network: "mainnet", read: "meta", error: lines.join("\n") } }], armedEnv());
    expect(r).toEqual([{ cause: "canary.read_failed", result: "sent" }]);
    const parts = tg.delivered("sendMessage");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(4);
    parts.forEach((p, i) => {
      expect(p.text.length).toBeLessThanOrEqual(MAX_ALERT_CHARS);
      expect(p.text.startsWith(`(${i + 1}/${parts.length}) `)).toBeTrue();
    });
    const all = parts.map((p) => p.text).join("\n");
    expect(all).toContain("[ACT] canary.read_failed");
    expect(all).toContain("line 000 of the read error");
    expect(all).toContain("line 399 of the read error");
    expect(all).toContain("Glossary: ops/alerts/GLOSSARY.md#canary.read_failed");
  });

  test("one line longer than a message is cut into parts too", async () => {
    await deliver([{ kind: "builder.read_failed", detail: { venue: "aster", error: "x".repeat(9000) } }], armedEnv());
    const parts = tg.delivered("sendMessage");
    expect(parts.length).toBe(4); // the head line, then the 9,000 character line in three pieces with the rest after
    for (const p of parts) expect(p.text.length).toBeLessThanOrEqual(MAX_ALERT_CHARS);
    const runs = parts.flatMap((p) => p.text.match(/x{100,}/g) ?? []);
    expect(runs.reduce((n, r) => n + r.length, 0)).toBe(9000);
    expect(parts[3]!.text).toContain("Glossary: ops/alerts/GLOSSARY.md#builder.read_failed");
  });

  test("a 429 is retried after its retry_after, and the alert is delivered once", async () => {
    tg.script({ status: 429, retryAfter: 1 });
    const r = await deliver([{ kind: "deploy.rollback", detail: { sha: "a1b2c3d", previous: "9f8e7d6" } }], armedEnv());
    expect(r).toEqual([{ cause: "deploy.rollback", result: "sent" }]);
    expect(tg.calls.map((c) => c.status)).toEqual([429, 200]);
    expect(tg.calls[1]!.at - tg.calls[0]!.at).toBeGreaterThanOrEqual(1000); // the real wait, measured by the stand-in
    expect(tg.calls[1]!.text).toBe(tg.calls[0]!.text);
  });

  test("the wait is the stand-in's retry_after, not a fixed delay", async () => {
    const waits: number[] = [];
    tg.script({ status: 429, retryAfter: 7 }, { status: 429, retryAfter: 3 });
    const r = await deliver([{ kind: "reconciler.mismatch" }], armedEnv(), { sleep: async (ms) => void waits.push(ms) });
    expect(r.map((x) => x.result)).toEqual(["sent"]);
    expect(waits).toEqual([7000, 3000]);
    expect(tg.delivered().length).toBe(1);
  });

  test("a 429 asking for more than 30 s fails without waiting; the other alerts still go and it goes next run", async () => {
    const waits: number[] = [];
    tg.script({ status: 429, retryAfter: 120 });
    const r = await deliver([{ kind: "x402.settle_dropped" }, { kind: "geo.refresh_failed" }], armedEnv(), { sleep: async (ms) => void waits.push(ms) });
    expect(r).toEqual([
      { cause: "x402.settle_dropped", result: "failed" },
      { cause: "geo.refresh_failed", result: "sent" },
    ]);
    expect(waits).toEqual([]);
    // next run: with Redis the failed event was put back on the list; without it the caller hands it again
    const r2 = redis ? await runOpsAlerts(deps(), { env: armedEnv(), hl: null, dedupe }) : await deliver([{ kind: "x402.settle_dropped" }], armedEnv());
    expect(r2).toEqual([{ cause: "x402.settle_dropped", result: "sent" }]);
    expect(tg.delivered().map((c) => c.text.split("\n")[0])).toEqual(["[INFO] geo.refresh_failed", expect.stringContaining("x402.settle_dropped")]);
  });

  test("d1-alerts-01: a multi-part alert that fails on a later part resumes there next run, never from part 1", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(3, "0")} of the read error`);
    const ev: OpsEvent = { kind: "canary.read_failed", detail: { venue: "hl", network: "mainnet", read: "meta", error: lines.join("\n") } };
    tg.script({ status: 200 }, { status: 500 });
    expect(await deliver([ev], armedEnv())).toEqual([{ cause: "canary.read_failed", result: "failed" }]);
    expect(tg.delivered("sendMessage").length).toBe(1);
    // the error names the resume point
    tg.script({ status: 200 }, { status: 500 });
    const err = await sendOpsAlert(toOpsAlert(ev), { armed: true, tokenFile: join(dir, "token"), chatId: CHAT, dedupeMinutes: 30, http: fetch, apiBase: tg.url, dedupe: memoryDedupe() }).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramSendError);
    expect((err as TelegramSendError).sentParts).toBe(1);
    tg.reset();
    // next run: with Redis the event went back on the list with sentParts; without it the caller hands that record
    const r2 = redis ? await runOpsAlerts(deps(), { env: armedEnv(), hl: null, dedupe }) : await runOpsAlerts(deps(), { env: armedEnv(), hl: null, dedupe, events: [{ ...ev, sentParts: 1 } as OpsEvent] });
    expect(r2).toEqual([{ cause: "canary.read_failed", result: "sent" }]);
    const texts = tg.delivered("sendMessage").map((c) => c.text);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some((t) => t.startsWith("(1/"))).toBeFalse();
    expect(texts[0]!.startsWith("(2/")).toBeTrue();
  });

  test("a 500 on one alert does not drop the next one", async () => {
    tg.script({ status: 500 });
    const r = await deliver([{ kind: "catalog.reduce_only" }, { kind: "spreads.market_changed" }], armedEnv());
    expect(r.map((x) => x.result)).toEqual(["failed", "sent"]);
    expect(tg.delivered().length).toBe(1);
  });

  test("nothing posts when ALERTS_ARMED is off, unset, or the token file is missing", async () => {
    const causes = Object.keys(CAUSES);
    for (const env of [armedEnv({ ALERTS_ARMED: "0" }), { ...armedEnv(), ALERTS_ARMED: undefined }, armedEnv({ ALERTS_ARMED: "yes" }), armedEnv({ ALERTS_TOKEN_FILE: join(dir, "absent") })]) {
      const r = await deliver(causes.map((kind) => ({ kind })), env);
      expect(r.length).toBe(causes.length);
      expect(new Set(r.map((x) => x.result))).toEqual(new Set(["logged"]));
    }
    expect(tg.calls.length).toBe(0);
  });

  test("the stand-in records sendPhoto (multipart upload) for poster posts", async () => {
    const f = new FormData();
    f.set("chat_id", CHAT);
    f.set("caption", "Update 1 is live");
    f.set("photo", new Blob([new Uint8Array(2048)], { type: "image/png" }), "update-01.png");
    const res = await fetch(`${tg.url}/bot${TOKEN}/sendPhoto`, { method: "POST", body: f });
    expect(res.status).toBe(200);
    expect(tg.delivered("sendPhoto")).toEqual([expect.objectContaining({ method: "sendPhoto", chatId: CHAT, text: "Update 1 is live", photo: 2048 })]);
  });
});
