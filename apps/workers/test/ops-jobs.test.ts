// ops-alerts and log-retention jobs: definitions, Redis path (legacy pub/sub producers and the durable list),
// armed sending to a fake Telegram server with dedupe, unarmed logging, glossary refusal, retention clock +8 days.
import { createRedis, logger, type JobDeps, type Redis } from "@capstan/core";
import { emitOpsEvent, OPS_ALERT_CHANNEL, OPS_ALERT_LIST, containsIp } from "@capstan/telemetry";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { job as retentionJob, runLogRetention } from "../src/jobs/log-retention.job";
import { job as alertsJob, resetOpsAlertsState, runOpsAlerts, stopOpsAlertsSubscriber } from "../src/jobs/ops-alerts.job";

const TOKEN = "987654321:" + "ZZyyXXwwVVuuTTssRRqqPPooNNmmLLkk"; // fake token for the local fake server
const quiet = logger("t", { sink: () => {} });
const sent: string[] = [];
const fake = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => (sent.push(String(((await req.json()) as { text: string }).text)), Response.json({ ok: true })) });
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "capstan-opsjobs-"));
  writeFileSync(join(dir, "token"), TOKEN, { mode: 0o600 });
});
afterAll(async () => {
  fake.stop(true);
  await stopOpsAlertsSubscriber();
  rmSync(dir, { recursive: true, force: true });
});
const env = () => ({ ALERTS_ARMED: "1", ALERTS_TOKEN_FILE: join(dir, "token"), ALERTS_CHAT_ID: "-42", ALERTS_TELEGRAM_API: `http://127.0.0.1:${fake.port}` });

describe("ops jobs", () => {
  test("definitions", () => {
    expect(alertsJob).toMatchObject({ name: "ops-alerts", queue: "alertsDispatch", schedule: { every: 15_000 }, concurrency: 1 });
    expect(retentionJob).toMatchObject({ name: "log-retention", queue: "reconcileDaily", schedule: { pattern: "15 2 * * *" }, concurrency: 1 });
  });

  test("without Redis: unarmed logs only, armed sends once per cause", async () => {
    resetOpsAlertsState();
    sent.length = 0;
    const deps: JobDeps = { db: null, redis: null, cache: null, log: quiet, now: () => new Date(Date.UTC(2026, 10, 6)) };
    const ev = { kind: "catalog.source_errors", detail: [{ source: "aster" }] };
    const r1 = await runOpsAlerts(deps, { env: {}, hl: null, events: [ev] });
    expect(r1).toEqual([{ cause: "catalog.source_errors", result: "logged" }]);
    expect(sent.length).toBe(0);
    const r2 = await runOpsAlerts(deps, { env: env(), hl: null, events: [ev, ev] });
    expect(r2.map((r) => r.result)).toEqual(["sent", "deduped"]);
    expect(sent.length).toBe(1);
    expect(sent[0]).toStartWith("[ACT] catalog.source_errors");
  });

  test.skipIf(!process.env.REDIS_URL)("with Redis: legacy publish and durable emit both reach the group once each", async () => {
    resetOpsAlertsState();
    sent.length = 0;
    const redis: Redis = createRedis(process.env.REDIS_URL!);
    await redis.del(OPS_ALERT_LIST);
    await redis.del("capstan:ops-alert:dedupe:cause:lighter_rh.deposit_pin_mismatch", "capstan:ops-alert:dedupe:cause:anchor.poster_low_balance");
    const deps: JobDeps = { db: null, redis, cache: null, log: quiet, now: () => new Date() };
    await runOpsAlerts(deps, { env: env(), hl: null }); // starts the subscriber
    // an existing producer publishes on the channel only (lighter-rh-health style)
    await redis.publish(OPS_ALERT_CHANNEL, JSON.stringify({ kind: "lighter_rh.deposit_pin_mismatch", detail: { reason: "implementation moved" } }));
    // a new producer uses the durable emit (list + channel)
    await emitOpsEvent(redis, { kind: "anchor.poster_low_balance", detail: { poster: "0x" + "34".repeat(20), balanceWei: "1", minWei: "2" } });
    await Bun.sleep(300);
    const r = await runOpsAlerts(deps, { env: env(), hl: null });
    expect(r.map((x) => `${x.cause}:${x.result}`).sort()).toEqual(["anchor.poster_low_balance:sent", "lighter_rh.deposit_pin_mismatch:sent"]);
    expect(sent.length).toBe(2);
    expect(sent.join("\n")).not.toContain("0x" + "34".repeat(20)); // not a known address: hashed
    // nothing left over, and a repeat within 30 minutes is held back
    await redis.publish(OPS_ALERT_CHANNEL, JSON.stringify({ kind: "lighter_rh.deposit_pin_mismatch", detail: { reason: "again" } }));
    await Bun.sleep(300);
    expect((await runOpsAlerts(deps, { env: env(), hl: null })).map((x) => x.result)).toEqual(["deduped"]);
    await stopOpsAlertsSubscriber();
    await redis.quit();
  });

  test("the builder check runs at most every 10 minutes and its alerts are sent", async () => {
    resetOpsAlertsState();
    sent.length = 0;
    let now = Date.UTC(2026, 10, 6, 0, 0, 0);
    const deps: JobDeps = { db: null, redis: null, cache: null, log: quiet, now: () => new Date(now) };
    let reads = 0;
    const hl = { accountValue: async () => (reads++, "12"), abstraction: async () => "default" };
    const r = await runOpsAlerts(deps, { env: env(), hl, aster: { futuresAster: async () => "250" } });
    expect(r).toEqual([{ cause: "builder.hl_low", result: "sent" }]);
    now += 60_000;
    await runOpsAlerts(deps, { env: env(), hl });
    expect(reads).toBe(1);
    now += 10 * 60_000;
    await runOpsAlerts(deps, { env: env(), hl });
    expect(reads).toBe(2);
  });

  test("log-retention job with the clock 8 days ahead leaves only country codes", async () => {
    const logDir = join(dir, "logs");
    mkdirSync(join(logDir, "relay"), { recursive: true });
    const t0 = new Date(Date.UTC(2026, 10, 6));
    writeFileSync(join(logDir, "relay", "relay.jsonl"), JSON.stringify({ ts: t0.toISOString(), msg: "submit", ip: "198.51.100.23", ip_country: "PT" }) + "\n");
    const deps: JobDeps = { db: null, redis: null, cache: null, log: quiet, now: () => new Date(t0.getTime() + 8 * 86_400_000) };
    const r = await runLogRetention(deps, { dir: logDir });
    expect(r.logs.recordsStripped).toBe(1);
    const text = readFileSync(join(logDir, "relay", "relay.jsonl"), "utf8");
    expect(containsIp(text)).toBeFalse();
    expect(JSON.parse(text).ip_country).toBe("PT");
  });
});
