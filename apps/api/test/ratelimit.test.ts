// R6, R7, R18 (todo 29): free reads 120 a minute per /64, builds 30 a minute per wallet, writes stricter than reads,
// lock tiers multiply by 2 or 5, a burst answers 429 with Retry-After; amplification bounds on /quote, /risk/snapshot
// and /history/funding; a stranger naming a victim's wallet never spends the victim's buckets. Redis down: writes 503,
// public reads fall back to an in-process window.
import { describe, expect, test } from "bun:test";
import type { RouteSpec } from "@capstan/core";
import { RiskSnapshotZ, type Hex } from "@capstan/schema";
import { HISTORY_PAGE_ROWS } from "../src/routes/funding.routes";
import { apiKeyCheck, apiKeyVerifier, ownerSigVerifier } from "../src/auth";
import { BASE_LIMITS, classOf, memoryWindowStore, QUOTE_MAX_MARKETS, rateLimiter, type WindowStore } from "../src/ratelimit";
import { addr, gwKey, HOST, memoryNonceStore, signed, smallApp, T } from "./gw-helpers";

const ok = (c: { json(x: unknown): Response }) => c.json({ ok: true });
const routes: RouteSpec[] = [
  { method: "GET", path: "/read", auth: "public", handler: ok },
  { method: "POST", path: "/quote", auth: "public", handler: ok },
  { method: "POST", path: "/orders/build", auth: "owner_sig", authAlt: ["api_key"], handler: ok },
  { method: "POST", path: "/write", auth: "public", handler: ok },
];

function gateway(o: { ip?: () => string; mult?: (s: { owner?: string; apiKeyId?: string }) => 1 | 2 | 5; store?: WindowStore; now?: () => number } = {}) {
  let now = T;
  const clock = o.now ?? (() => now);
  const limiter = rateLimiter({ store: o.store ?? memoryWindowStore(), ipOf: o.ip ?? (() => "2001:db8:1:2::1"), multiplier: async (s) => (o.mult ? o.mult(s) : 1), now: clock });
  const verifiers = {
    owner_sig: ownerSigVerifier({ nonces: memoryNonceStore(), host: HOST, now: () => T + 1000, agentsOf: async () => [] }),
    api_key: apiKeyVerifier(apiKeyCheck({ verify: async (k) => (k.startsWith("cpst_") ? { id: k.slice(5), ownerWallet: null, tier: "free" } : null) })),
  };
  return { app: smallApp(routes, { verifiers, limiter }), tick: (ms: number) => void (now += ms) };
}

async function burst(n: number, f: () => Response | Promise<Response>) {
  const codes: number[] = [];
  let last: Response | null = null;
  for (let i = 0; i < n; i++) {
    last = await f();
    codes.push(last.status);
  }
  return { ok: codes.filter((c) => c === 200).length, limited: codes.filter((c) => c === 429).length, last: last! };
}

describe("rate limits", () => {
  test("classes-and-tiers", async () => {
    expect(classOf({ method: "GET", path: "/markets" })).toBe("read");
    expect(classOf({ method: "POST", path: "/quote" })).toBe("read");
    expect(classOf({ method: "POST", path: "/orders/build" })).toBe("build");
    expect(classOf({ method: "POST", path: "/orders/submit" })).toBe("write");
    expect(BASE_LIMITS.write).toBeLessThan(BASE_LIMITS.read);
    expect(BASE_LIMITS).toEqual({ read: 120, build: 30, write: 20 });

    // free reads: 120 per minute per /64 (two addresses in one /64 share it)
    let ipN = 0;
    const g = gateway({ ip: () => `2001:db8:1:2::${(++ipN % 7) + 1}` });
    const a = (await g.app).app;
    const reads = await burst(125, () => a.request("/v1/read"));
    expect(reads.ok).toBe(120);
    expect(reads.limited).toBe(5);
    expect(Number(reads.last.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await reads.last.json()) as { error: { code: string } }).error.code).toBe("VENUE_RATE_LIMITED");
    g.tick(60_001);
    expect((await a.request("/v1/read")).status).toBe(200);

    // writes: 20 per minute per IP
    const w = await burst(25, () => a.request("/v1/write", { method: "POST" }));
    expect(w.ok).toBe(20);

    // builds: 30 per minute per signing wallet; a Lock Holder gets 2x, a Lock Whale 5x
    for (const [mult, want] of [[1, 30], [2, 60], [5, 150]] as const) {
      const sk = gwKey(`builder-${mult}`);
      const gb = gateway({ mult: () => mult });
      const ab = (await gb.app).app;
      const body = JSON.stringify({ owner: addr(sk) });
      const r = await burst(want + 3, () => ab.request("/v1/orders/build", { method: "POST", headers: { "content-type": "application/json", ...signed(sk, { method: "POST", path: "/v1/orders/build", body }) }, body }));
      expect(r.ok).toBe(want);
      expect(r.limited).toBe(3);
    }
  });

  test("bounded-amplification", async () => {
    const a = (await gateway().app).app;
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `hyperliquid:-:M${i}`);
    const q = (n: number) => a.request("/v1/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marketIds: ids(n) }) });
    expect((await q(QUOTE_MAX_MARKETS)).status).toBe(200);
    const over = await q(QUOTE_MAX_MARKETS + 1);
    expect(over.status).toBe(400);
    expect(QUOTE_MAX_MARKETS).toBe(10);
    // /risk/snapshot takes at most 20 addresses; /history/funding pages at 10,000 rows
    const addrs = (n: number) => ({ addresses: Array.from({ length: n }, (_, i) => ({ venue: "hyperliquid", owner: `0x${(i + 1).toString(16).padStart(40, "0")}` })) });
    expect(RiskSnapshotZ.safeParse(addrs(20)).success).toBe(true);
    expect(RiskSnapshotZ.safeParse(addrs(21)).success).toBe(false);
    expect(HISTORY_PAGE_ROWS).toBe(10_000);
  });

  test("no-foreign-wallet-drain", async () => {
    const victim = gwKey("victim");
    const stranger = gwKey("stranger");
    let ip = "198.51.100.1";
    const g = gateway({ ip: () => ip });
    const a = (await g.app).app;
    const build = (h: Record<string, string>, body: string) => a.request("/v1/orders/build", { method: "POST", headers: { "content-type": "application/json", ...h }, body });
    const victimBody = JSON.stringify({ owner: addr(victim) });
    // a stranger with an API key builds 30 times naming the victim: its own key bucket fills, not the victim's
    const s = await burst(31, () => build({ authorization: "Bearer cpst_stranger" }, victimBody));
    expect(s.ok).toBe(30);
    expect(s.limited).toBe(1);
    // a stranger signing with its own key while naming the victim is refused at auth and counts nothing
    for (let i = 0; i < 40; i++) expect((await build(signed(stranger, { method: "POST", path: "/v1/orders/build", body: victimBody, owner: addr(victim) }), victimBody)).status).toBe(401);
    // the victim, from another address, still has all 30 builds
    ip = "203.0.113.200";
    const v = await burst(30, () => build(signed(victim, { method: "POST", path: "/v1/orders/build", body: victimBody }), victimBody));
    expect(v.ok).toBe(30);
    void (null as unknown as Hex);
  });

  test("redis-down", async () => {
    const down: WindowStore = { take: async () => Promise.reject(new Error("redis down")) };
    const a = (await gateway({ store: down }).app).app;
    expect((await a.request("/v1/write", { method: "POST" })).status).toBe(503);
    const r = await burst(121, () => a.request("/v1/read"));
    expect(r.ok).toBe(120); // the in-process window, same cap
  });
});
