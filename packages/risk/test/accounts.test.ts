// R8 Aster only from ingested signed reads; R9 HL reads cached 5 s and weight-budgeted (2 per clearinghouseState per
// dex): 100 owners refresh within the 80% budget.
import { describe, expect, test } from "bun:test";
import { createHlReader } from "@capstan/adapter-hyperliquid";
import { memoryMarketDataCache } from "@capstan/core";
import type { AccountSnapshot, Hex, VenueId } from "@capstan/schema";
import { createMemoryGovernor, hlInfoWeight, type VenueHttp } from "@capstan/venue-client";
import { memoryKv, readAccounts, readAccountsDetailed, type AccountAdapter } from "../src";
import { OWNER, pos, snap } from "./helpers";
import { fixtureHttp, USER_A } from "./recorded";
import { CFG } from "../../adapters/hyperliquid/test/helpers";

const caps = (venue: VenueId, publicAccountReads: boolean) => ({ venue, execution: true, keyType: "secp256k1" as const, delegation: "agent" as const, canWithdraw: false as const, builderFee: null, collateral: ["USDC"], directSubmitSupported: true, publicAccountReads });

describe("accounts", () => {
  test("aster-ingested-only", async () => {
    let asterReads = 0;
    const asterAdapter: AccountAdapter = { caps: caps("aster", false), getAccount: async () => (asterReads++, snap("aster", [])) };
    const hlAdapter: AccountAdapter = { caps: caps("hyperliquid", true), getAccount: async (id) => snap("hyperliquid", [pos("hyperliquid", "hyperliquid:-:ETH")], { identity: id }) };
    const adapters = new Map<VenueId, AccountAdapter>([["aster", asterAdapter], ["hyperliquid", hlAdapter]]);
    const ingested = new Map<string, AccountSnapshot>();
    const deps = { adapters, asterIngested: async (o: Hex) => ingested.get(o.toLowerCase()) ?? null, cache: memoryKv() };
    const ids = [{ venue: "aster" as const, owner: OWNER }, { venue: "hyperliquid" as const, owner: OWNER }];
    // no ingested read: Aster is pending with needs_signed_read, and the adapter (a server-side read) is never called
    const r1 = await readAccountsDetailed(ids, deps);
    expect(r1.snapshots.map((s) => s.venue)).toEqual(["hyperliquid"]);
    expect(r1.pending).toEqual([{ venue: "aster", identity: { venue: "aster", owner: OWNER }, status: "needs_signed_read", reason: expect.stringContaining("signed read") }]);
    expect(asterReads).toBe(0);
    // with an ingested signed read: that snapshot, still no server-side read
    const asterSnap = { ...snap("aster", [pos("aster", "aster:-:ETHUSDT")]), source: "client_read" } as AccountSnapshot;
    ingested.set(OWNER.toLowerCase(), asterSnap);
    const r2 = await readAccounts(ids, deps);
    expect(r2.find((s) => s.venue === "aster")).toEqual(asterSnap);
    expect(asterReads).toBe(0);
    // data-only venues and Lighter without an account index are pending, never fetched
    const r3 = await readAccountsDetailed([{ venue: "variational", owner: OWNER }, { venue: "lighter-mainnet", owner: OWNER }], deps);
    expect(r3.pending.map((p) => p.status)).toEqual(["excluded", "unavailable"]);
  });

  test("budget", async () => {
    // the real HL reader on recorded fixtures, its HTTP charged to an in-memory governor on a simulated clock
    let clock = 1_793_500_000_000;
    const gov = createMemoryGovernor("test-egress", { now: () => clock, sleep: async (ms) => void (clock += ms) });
    const fx = fixtureHttp();
    let peakPct = 0;
    const governed: VenueHttp = {
      ...fx,
      async postJson<T>(path: string, body: unknown, cost?: number): Promise<T> {
        await gov.acquire("hyperliquid", cost ?? hlInfoWeight(String((body as { type?: string }).type)), { priority: "free" });
        peakPct = Math.max(peakPct, gov.usage("hyperliquid").pct);
        return fx.postJson<T>(path, body, cost);
      },
    };
    const reader = createHlReader(CFG, governed, memoryMarketDataCache(), { now: () => clock });
    const owners = Array.from({ length: 100 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Hex);
    const adapters = new Map<VenueId, AccountAdapter>([["hyperliquid", { caps: caps("hyperliquid", true), getAccount: (id) => reader.getAccount(id) }]]);
    const kv = memoryKv(() => clock);
    const ids = owners.map((owner) => ({ venue: "hyperliquid" as const, owner }));
    const t0 = clock;
    const r = await readAccountsDetailed(ids, { adapters, asterIngested: async () => null, cache: kv });
    expect(r.snapshots.length).toBe(100);
    expect(r.pending).toEqual([]);
    // every account read is 2 weight per dex with listed markets (core + 4 HIP-3 dexes in the recording)
    const chs = fx.calls.filter((c) => c.body.type === "clearinghouseState");
    expect(chs.length).toBe(500);
    expect(chs.every((c) => c.cost === 2)).toBe(true);
    // the free lane never went past 80% of the 1,200 per minute budget, and 100 owners fit the 5-minute compute cycle
    expect(peakPct).toBeLessThanOrEqual(80);
    expect(clock - t0).toBeLessThan(5 * 60_000);
    // the master address only: every account call names the owner, never an agent
    expect(new Set(chs.map((c) => String(c.body.user).toLowerCase())).size).toBe(100);
    // within 5 s of its read an owner comes from the cache: no venue call at all
    const last = ids.slice(-1);
    const before = fx.calls.length;
    clock += 4_000;
    await readAccounts(last, { adapters, asterIngested: async () => null, cache: kv });
    expect(fx.calls.length).toBe(before);
    // after 5 s it is read again (2 weight x 5 dexes)
    clock += 1_001;
    await readAccounts(last, { adapters, asterIngested: async () => null, cache: kv });
    expect(fx.calls.filter((c) => c.body.type === "clearinghouseState").length).toBe(505);
  }, 60_000);
});
