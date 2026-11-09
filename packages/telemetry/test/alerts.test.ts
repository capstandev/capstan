import { logger } from "@capstan/core";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkBuilderBalances,
  formatOpsAlert,
  hlBuilderReader,
  MAX_ALERT_CHARS,
  MAX_ALERT_PARTS,
  memoryDedupe,
  sendOpsAlert,
  StalenessMonitor,
  TelegramSendError,
  toOpsAlert,
  splitAlert,
  truncateAlert,
  type OpsEvent,
} from "../src";
import clearinghouse from "./fixtures/hl-clearinghouse-state.json";
import abstraction from "./fixtures/hl-user-abstraction.json";

const TOKEN = "123456789:" + "AAbbCCddEEffGGhhIIjjKKllMMnnOOpp"; // fake bot token for the local fake server
let dir: string;
let tokenFile: string;
const got: { path: string; body: Record<string, unknown> }[] = [];
let status = 200;
const fake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    got.push({ path: new URL(req.url).pathname, body: (await req.json()) as Record<string, unknown> });
    return Response.json({ ok: status === 200 }, { status });
  },
});
const apiBase = `http://127.0.0.1:${fake.port}`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "capstan-alerts-"));
  tokenFile = join(dir, "telegram-token");
  writeFileSync(tokenFile, TOKEN + "\n", { mode: 0o600 });
});
afterAll(() => {
  fake.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const ev = (kind: string, detail: unknown = {}): OpsEvent => ({ kind, detail });
const USER = "0x" + "9f".repeat(20);

describe("ops alerts", () => {
  test("armed-dedupe-plain: unarmed logs only; armed sends one message per cause per 30 minutes in four plain parts", async () => {
    got.length = 0;
    status = 200;
    const lines: string[] = [];
    const log = logger("workers", { sink: (l) => lines.push(l) });
    let now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const dedupe = memoryDedupe();
    const base = { tokenFile, chatId: "-100123", dedupeMinutes: 30 as const, http: fetch, apiBase, now: () => now, dedupe, log };
    const a = toOpsAlert(ev("reconciler.mismatch", { day: "2026-11-05", unmatchedFills: 4, owner: USER }));

    expect(await sendOpsAlert(a, { ...base, armed: false })).toBe("logged");
    expect(got.length).toBe(0);

    expect(await sendOpsAlert(a, { ...base, armed: true })).toBe("sent");
    expect(await sendOpsAlert(a, { ...base, armed: true })).toBe("deduped");
    now += 29 * 60_000;
    expect(await sendOpsAlert(a, { ...base, armed: true })).toBe("deduped");
    // another cause is not held back by the first one
    expect(await sendOpsAlert(toOpsAlert(ev("catalog.new_dexes", ["abc"])), { ...base, armed: true })).toBe("sent");
    now += 2 * 60_000;
    expect(await sendOpsAlert(a, { ...base, armed: true })).toBe("sent");
    expect(got.length).toBe(3);

    const text = String(got[0]!.body.text);
    expect(got[0]!.body.chat_id).toBe("-100123");
    for (const part of ["What happened: ", "Who is affected: ", "What was done: ", "What is next: "]) expect(text).toContain(part);
    expect(text).toStartWith("[ACT] reconciler.mismatch");
    // user identifiers: no raw address, at most a short hash
    const withUser = formatOpsAlert({ ...a, what: `${a.what} for ${USER} from 203.0.113.7` });
    expect(withUser).not.toContain(USER);
    expect(withUser).toMatch(/wallet#[A-Za-z0-9_-]{8}/);
    expect(withUser).not.toContain("203.0.113.7");
    // known service addresses (the owner funds them) stay in full
    const poster = "0x" + "12".repeat(20);
    expect(formatOpsAlert({ ...a, what: poster }, [poster])).toContain(poster);
  });

  test("token-never-printed: the token is read from a 600 file and never reaches logs, errors or process args", async () => {
    got.length = 0;
    const lines: string[] = [];
    const log = logger("workers", { sink: (l) => lines.push(l), level: "debug" });
    const a = toOpsAlert(ev("gas.low", { service: "facilitator", balance: "1", minimum: "2" }));
    const deps = { armed: true, tokenFile, chatId: "-1", dedupeMinutes: 30 as const, http: fetch, apiBase, dedupe: memoryDedupe(), log };

    status = 500;
    const err = await sendOpsAlert(a, deps).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramSendError);
    expect(String(err.message)).not.toContain(TOKEN);
    expect(String(err.stack)).not.toContain(TOKEN);

    // a network error whose message carries the URL is replaced by a plain one
    const throwing = (async (url: string) => {
      throw new Error(`connect failed for ${url}`);
    }) as unknown as typeof fetch;
    const err2 = await sendOpsAlert(a, { ...deps, http: throwing, dedupe: memoryDedupe() }).catch((e) => e);
    expect(String(err2.message)).not.toContain(TOKEN);

    status = 200;
    expect(await sendOpsAlert(a, { ...deps, dedupe: memoryDedupe() })).toBe("sent");
    expect(got.at(-1)!.path).toBe(`/bot${TOKEN}/sendMessage`); // only the request URL holds it
    expect(JSON.stringify(got.at(-1)!.body)).not.toContain(TOKEN);

    // a token file readable by others is refused (logged, not sent)
    const loose = join(dir, "loose-token");
    writeFileSync(loose, TOKEN, { mode: 0o600 });
    chmodSync(loose, 0o644);
    expect(await sendOpsAlert(a, { ...deps, tokenFile: loose, dedupe: memoryDedupe() })).toBe("logged");
    // no token file at all: logged
    expect(await sendOpsAlert(a, { ...deps, tokenFile: join(dir, "missing"), dedupe: memoryDedupe() })).toBe("logged");

    for (const l of lines) expect(l).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain(TOKEN.split(":")[1]!);
    expect(process.argv.join(" ")).not.toContain(TOKEN);
  });

  test("staleness: above 3 s on a T1 venue for 5 minutes raises one act alert; recovery sends one info", async () => {
    const events: OpsEvent[] = [];
    const m = new StalenessMonitor((e) => void events.push(e));
    const t0 = Date.UTC(2026, 10, 6, 12, 0, 0);
    for (let s = 0; s < 300; s += 10) await m.observe("hyperliquid", 4_000, t0 + s * 1000);
    expect(events.length).toBe(0); // 4 min 50 s stale: not yet
    for (let s = 300; s <= 900; s += 10) await m.observe("hyperliquid", 4_500, t0 + s * 1000);
    expect(events.length).toBe(1);
    const act = toOpsAlert(events[0]!);
    expect(act.cause).toBe("quote.stale_t1");
    expect(act.severity).toBe("act");
    await m.observe("hyperliquid", 400, t0 + 901_000);
    await m.observe("hyperliquid", 300, t0 + 911_000);
    expect(events.length).toBe(2);
    const info = toOpsAlert(events[1]!);
    expect(info.cause).toBe("quote.stale_t1_recovered");
    expect(info.severity).toBe("info");
    // a short stale burst resets; data-only venues never alert
    for (let s = 0; s < 200; s += 10) await m.observe("aster", 5_000, t0 + s * 1000);
    await m.observe("aster", 100, t0 + 200_000);
    for (let s = 0; s < 900; s += 10) await m.observe("variational", 60_000, t0 + s * 1000);
    expect(events.length).toBe(2);
  });

  test("truncate: text above 3,600 characters is cut at a line end and ends with +N more", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${String(i).padStart(3, "0")} ${"x".repeat(24)}`);
    const out = truncateAlert(lines.join("\n"));
    expect(out.length).toBeLessThanOrEqual(MAX_ALERT_CHARS);
    const outLines = out.split("\n");
    const last = outLines.pop()!;
    const n = Number(/^\+(\d+) more$/.exec(last)![1]);
    expect(outLines.length + n).toBe(300);
    outLines.forEach((l, i) => expect(l).toBe(lines[i]!)); // whole lines only
    expect(truncateAlert("short")).toBe("short");
    // through formatOpsAlert as well
    const big = formatOpsAlert({ cause: "catalog.new_dexes", severity: "info", what: lines.join("\n"), affected: "a", done: "b", next: "c" });
    expect(big.length).toBeLessThanOrEqual(MAX_ALERT_CHARS);
    expect(big).toMatch(/\n\+\d+ more$/);
    // one huge first line is cut too
    const one = truncateAlert("y".repeat(5000) + "\nend");
    expect(one.length).toBeLessThanOrEqual(MAX_ALERT_CHARS);
    expect(one).toEndWith("\n+1 more");
  });

  test("split: long text becomes numbered parts at line ends; past the part cap the last part ends with +N more", () => {
    expect(splitAlert("short")).toEqual(["short"]);
    const lines = Array.from({ length: 300 }, (_, i) => `line ${String(i).padStart(3, "0")} ${"x".repeat(24)}`);
    const parts = splitAlert(lines.join("\n"));
    expect(parts.length).toBe(3);
    parts.forEach((p, i) => {
      expect(p.length).toBeLessThanOrEqual(MAX_ALERT_CHARS);
      expect(p.startsWith(`(${i + 1}/3) `)).toBeTrue();
    });
    expect(parts.map((p) => p.replace(/^\(\d\/\d\) /, "")).join("\n")).toBe(lines.join("\n")); // nothing lost
    const huge = Array.from({ length: 2000 }, (_, i) => `row ${i} ${"z".repeat(30)}`);
    const capped = splitAlert(huge.join("\n"));
    expect(capped.length).toBe(MAX_ALERT_PARTS);
    for (const p of capped) expect(p.length).toBeLessThanOrEqual(MAX_ALERT_CHARS);
    expect(capped.at(-1)!).toMatch(/\n\+\d+ more$/);
  });

  test("builder-balances: HL under 100 USDC or not standard, and Aster under 100 ASTER, raise one act alert each (read-only)", async () => {
    // recorded live shapes (fixtures), values replaced per case
    const hlHttp = (accountValue: string, mode: string) =>
      (async (_u: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { type: string };
        if (body.type === "clearinghouseState") return Response.json({ ...clearinghouse, marginSummary: { ...clearinghouse.marginSummary, accountValue } });
        if (body.type === "userAbstraction") return Response.json(mode);
        return new Response("bad", { status: 422 });
      }) as unknown as typeof fetch;
    expect(abstraction).toBe("default");
    const run = async (av: string, mode: string, aster: string | null) => {
      const events: OpsEvent[] = [];
      const r = await checkBuilderBalances({ hl: hlBuilderReader("0x" + "01".padStart(40, "0"), hlHttp(av, mode)), aster: { futuresAster: async () => aster }, emit: (e) => void events.push(e) });
      return { r, kinds: events.map((e) => e.kind) };
    };
    expect((await run("150.5", "default", "120")).kinds).toEqual([]);
    expect((await run("99.99", "default", "120")).kinds).toEqual(["builder.hl_low"]);
    expect((await run("150", "unifiedAccount", "120")).kinds).toEqual(["builder.hl_not_standard"]);
    const low = await run("150", "default", "99.5");
    expect(low.kinds).toEqual(["builder.aster_low"]);
    expect(low.r.aster).toEqual({ balance: "99.5", ok: false });
    // Aster read not available off the VPS: skipped, never guessed
    const off = await run("150", "default", null);
    expect(off.kinds).toEqual([]);
    expect(off.r.aster!.ok).toBeNull();
    for (const k of ["builder.hl_low", "builder.hl_not_standard", "builder.aster_low"]) expect(toOpsAlert({ kind: k }).severity).toBe("act");
    // the reader only POSTs public info requests
    const calls: string[] = [];
    const spy = (async (u: string, init?: RequestInit) => (calls.push(`${init?.method} ${u} ${init?.body}`), hlHttp("150", "default")(u, init))) as unknown as typeof fetch;
    await hlBuilderReader("0xabc", spy, "https://api.hyperliquid.xyz").accountValue();
    expect(calls[0]).toBe('POST https://api.hyperliquid.xyz/info {"type":"clearinghouseState","user":"0xabc"}');
  });

  test.skipIf(!process.env.CAPSTAN_LIVE)("live: Hyperliquid public reads for a builder address parse", async () => {
    const r = hlBuilderReader("0x0000000000000000000000000000000000000001");
    expect(await r.accountValue()).toMatch(/^\d/);
    expect(typeof (await r.abstraction())).toBe("string");
  });

  test("an unknown event kind becomes ops.unknown_event, never dropped", () => {
    const a = toOpsAlert({ kind: "something.new" });
    expect(a.cause).toBe("ops.unknown_event");
    expect(a.what).toContain("something.new");
    // the producer's critical wins over a lower glossary severity
    expect(toOpsAlert({ kind: "catalog.new_dexes", severity: "critical" }).severity).toBe("critical");
  });
});
