// Canary jobs (todo 41 R9): definitions, the read canary on stub venues (ok, a failed health read, host choice by
// network), and the signed canary's refusals, skip reasons, alert on failure and cast-based signing.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@capstan/core";
import { job as readJob, runReadCanary } from "../src/jobs/canary-read.job";
import { castDigestSigner, job as signedJob, OPS_ALERT_CHANNEL, runSignedCanary } from "../src/jobs/canary-signed.job";

const log = logger("t", { sink: () => {} });
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

/** Stub venues: every read answers like the live venue did on 2026-11-06 (shape only). */
function venues(opts: { failHl?: boolean } = {}) {
  const hosts: string[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    hosts.push(u.host);
    if (u.host.includes("hyperliquid")) {
      if (opts.failHl) return new Response("bad gateway", { status: 502 });
      const t = JSON.parse(String(init?.body)).type;
      if (t === "meta") return json({ universe: [{ name: "BTC" }] });
      if (t === "l2Book") return json({ levels: [[{ px: "76000" }], [{ px: "76001" }]] });
      return json([{ universe: [] }, [{ funding: "0.0000125" }]]);
    }
    if (u.host.includes("lighter")) {
      if (u.pathname.endsWith("/orderBooks")) return json({ code: 200, order_books: [{ market_id: 4097, market_type: "perp", status: "active" }] });
      if (u.pathname.endsWith("/orderBookOrders")) return json({ code: 200, asks: [], bids: [] });
      return json({ code: 200, resolution: "1h", fundings: [] });
    }
    if (u.pathname.endsWith("/ping")) return json({});
    if (u.pathname.endsWith("/depth")) return json({ bids: [["75580", "1"]], asks: [] });
    return json({ symbol: "BTCUSDT", lastFundingRate: "0.0001" });
  };
  return { f, hosts };
}

describe("canary-read", () => {
  test("definition: every 15 minutes", () => {
    expect(readJob).toMatchObject({ name: "canary-read", queue: "alertsDispatch", schedule: { pattern: "*/15 * * * *" }, concurrency: 1 });
  });

  test("ok on every venue: 12 reads, no alert; testnet profile reads testnet hosts only", async () => {
    const published: unknown[] = [];
    const v = venues();
    const r = await runReadCanary({ log, publish: async (_c, p) => void published.push(p) }, { fetch: v.f, env: { CAPSTAN_NETWORK: "testnet" } });
    expect(r).toHaveLength(12);
    expect(r.every((x) => x.ok && x.network === "testnet")).toBe(true);
    expect(published).toEqual([]);
    expect(new Set(v.hosts)).toEqual(new Set(["api.hyperliquid-testnet.xyz", "testnet.zklighter.elliot.ai", "api.rh-testnet.lighter.xyz", "fapi.asterdex-testnet.com"]));
  });

  test("mainnet profile reads mainnet hosts (keyless reads only)", async () => {
    const v = venues();
    await runReadCanary({ log }, { fetch: v.f, env: { CAPSTAN_NETWORK: "mainnet" } });
    expect(new Set(v.hosts)).toEqual(new Set(["api.hyperliquid.xyz", "mainnet.zklighter.elliot.ai", "api.rh.lighter.xyz", "fapi.asterdex.com"]));
  });

  test("a failed health read alerts once and skips that venue's other reads", async () => {
    const published: { ch: string; p: unknown }[] = [];
    const r = await runReadCanary({ log, publish: async (ch, p) => void published.push({ ch, p }) }, { fetch: venues({ failHl: true }).f, env: { CAPSTAN_NETWORK: "testnet" } });
    expect(r.filter((x) => !x.ok).map((x) => `${x.venue}:${x.kind}`)).toEqual(["hyperliquid:health", "hyperliquid:book", "hyperliquid:funding"]);
    expect(published).toEqual([{ ch: OPS_ALERT_CHANNEL, p: { kind: "canary.read_failed", detail: { venue: "hyperliquid", network: "testnet", read: "health", error: "HTTP 502" } } }]);
  });
});

describe("canary-signed", () => {
  test("definition: hourly", () => {
    expect(signedJob).toMatchObject({ name: "canary-signed", queue: "alertsDispatch", schedule: { pattern: "7 * * * *" }, concurrency: 1 });
  });

  test("skip reasons without wallets, and an alert when a probe fails", async () => {
    const none = await runSignedCanary({ log }, { env: { CAPSTAN_NETWORK: "testnet" } });
    expect(none.map((x) => `${x.venue}:${x.status}`)).toEqual(["hyperliquid:skipped", "lighter:skipped", "aster:skipped"]);
    expect(none[0]!.detail).toContain("A2");
    const published: unknown[] = [];
    const bad = await runSignedCanary({ log, publish: async (_c, p) => void published.push(p) }, { env: { CAPSTAN_NETWORK: "testnet" }, hl: async () => ({ venue: "hyperliquid", status: "failed", detail: "order rejected: VENUE_ERROR" }) });
    expect(bad[0]!.status).toBe("failed");
    expect(published).toEqual([{ kind: "canary.signed_failed", detail: { venue: "hyperliquid", error: "order rejected: VENUE_ERROR" } }]);
  });

  test("castDigestSigner splits cast's 65-byte signature into r, s, v", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canary-cast-"));
    const cast = join(dir, "cast");
    const r = "11".repeat(32);
    const s = "22".repeat(32);
    writeFileSync(cast, `#!/bin/bash\n[ "$1 $2 $3" = "wallet sign --no-hash" ] || exit 4\necho 0x${r}${s}1c\n`);
    chmodSync(cast, 0o755);
    const sig = await castDigestSigner("/ks", "/pw", cast)(`0x${"33".repeat(32)}`);
    expect(sig).toEqual({ r: `0x${r}`, s: `0x${s}`, v: 28 });
  });
});
