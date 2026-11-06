// Depeg rules R5, R6, R16 (todo 17): readings only flag and split comparisons; they never refuse or convert.
import { describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import type { VenueId } from "@capstan/schema";
import { ADDRESSES } from "@capstan/schema";
import { applyChainlinkCrossCheck, bpsFromPrices, cachedDepegReader, CHAINLINK_MAX_AGE_MS, createDepegReader, DEPEG_KEYS, usdgPerEthFromSqrt, usdgPerEthFromTick, type DepegReading } from "../src/depeg";
import { routeQuote, type QuoteAdapter } from "../src/route";
import { cacheAdapter, depegOf, deps, funding, genericMarket, ladder, staticCache } from "./helpers";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const reading = (bps: number, ageMs = 1000): DepegReading => ({ bps, asOf: NOW - ageMs, source: "uniswap_v3", method: "twap_5m" });

async function mixed() {
  const cache = staticCache();
  const hl = genericMarket("hyperliquid:-:ETH", "hyperliquid", { lotSize: "0.0001" }); // USDC
  const rh = genericMarket("lighter-rh:-:ETH", "lighter-rh", { lotSize: "0.0001", tickSize: "0.01" }); // USDG
  const lt = genericMarket("lighter-mainnet:-:ETH", "lighter-mainnet", { lotSize: "0.0001", tickSize: "0.01" }); // USDC
  await cache.putBook(ladder(hl.id, "2000", "0.5", "5", iso(NOW - 10)));
  await cache.putBook(ladder(rh.id, "1990", "0.5", "5", iso(NOW - 10))); // USDG prices sit lower: cheapest number
  await cache.putBook(ladder(lt.id, "2000", "0.4", "5", iso(NOW - 10)));
  for (const m of [hl, rh, lt]) await cache.putFunding(funding(m.id, "0", iso(NOW)));
  const adapters = new Map<VenueId, QuoteAdapter>((["hyperliquid", "lighter-rh", "lighter-mainnet"] as const).map((v) => [v, cacheAdapter(v, cache)]));
  const req = { canonicalAsset: "CR:ETH" as const, side: "buy" as const, sizeBase: "1", leverage: 2, holdHours: 0, orderType: "market" as const };
  return { cache, hl, rh, lt, adapters, req };
}

describe("depeg", () => {
  test("flag-25bps", async () => {
    const s = await mixed();
    // 20 bps: within the band, one group, no flags, the cheapest leg overall is best
    let q = await routeQuote(s.req, deps({ markets: [s.hl, s.rh, s.lt], cache: s.cache, adapters: s.adapters, depeg: depegOf(reading(-20)), now: () => NOW }));
    expect(q.legs.every((l) => l.flags.length === 0)).toBe(true);
    expect(q.collateralGroups.length).toBe(1);
    // 30 bps: USDG legs and the USDC legs they are compared with carry DEPEG_FLAG; separate collateral groups
    q = await routeQuote(s.req, deps({ markets: [s.hl, s.rh, s.lt], cache: s.cache, adapters: s.adapters, depeg: depegOf(reading(-30)), now: () => NOW }));
    expect(q.legs.every((l) => l.flags.includes("DEPEG_FLAG"))).toBe(true);
    expect(q.collateralGroups.map((g) => g.collateral).sort()).toEqual(["USDC", "USDG"]);
    const usdc = q.collateralGroups.find((g) => g.collateral === "USDC")!;
    const usdg = q.collateralGroups.find((g) => g.collateral === "USDG")!;
    expect(usdc.ranking.sort()).toEqual([s.hl.id, s.lt.id].sort());
    expect(usdg.ranking).toEqual([s.rh.id]);
    // amounts are never converted: the USDG leg keeps its own USDG price and collateral
    const rh = q.legs.find((l) => l.venue === "lighter-rh")!;
    expect(rh.collateralAsset).toBe("USDG");
    expect(Number(rh.avgFillPx)).toBeCloseTo(1990.5, 6);
    expect(rh.status).toBe("ok"); // flagged, never refused
    // exactly at 25 bps: still one group
    q = await routeQuote(s.req, deps({ markets: [s.hl, s.rh, s.lt], cache: s.cache, adapters: s.adapters, depeg: depegOf(reading(25)), now: () => NOW }));
    expect(q.collateralGroups.length).toBe(1);
    // only USDC legs: nothing to compare, no flag even with a broken peg
    q = await routeQuote({ ...s.req, canonicalAsset: undefined, marketIds: [s.hl.id, s.lt.id] }, deps({ markets: [s.hl, s.rh, s.lt], cache: s.cache, adapters: s.adapters, depeg: depegOf(reading(-300)), now: () => NOW }));
    expect(q.legs.every((l) => l.flags.length === 0)).toBe(true);
  });

  test("fail-closed", async () => {
    const s = await mixed();
    // the read failed (null), threw, or is older than 5 minutes: DEPEG_UNKNOWN, never assumed pegged
    for (const depeg of [depegOf(null), { usdgUsdcBps: async () => Promise.reject(new Error("rpc down")), usdtUsdcBps: async () => null }, depegOf(reading(0, 5 * 60_000 + 1))]) {
      const q = await routeQuote(s.req, deps({ markets: [s.hl, s.rh, s.lt], cache: s.cache, adapters: s.adapters, depeg, now: () => NOW }));
      expect(q.legs.every((l) => l.flags.includes("DEPEG_UNKNOWN"))).toBe(true);
      expect(q.collateralGroups.length).toBe(2);
      expect(q.legs.every((l) => l.status === "ok")).toBe(true);
    }
    // a 4:59 old reading still counts
    const q = await routeQuote(s.req, deps({ markets: [s.hl, s.rh, s.lt], cache: s.cache, adapters: s.adapters, depeg: depegOf(reading(0, 5 * 60_000 - 1000)), now: () => NOW }));
    expect(q.legs.every((l) => l.flags.length === 0)).toBe(true);

    // Chainlink alone can never make a reading: the pool read fails while both Chainlink feeds answer fresh (USDG at
    // 0.97 USD, a 300 bps move), and with no pool price and no venue marks the reader still returns null
    const usdgFeed = ADDRESSES.chainlinkUsdgUsd.address.toLowerCase();
    const usdcFeed = ADDRESSES.chainlinkUsdcUsd.address.toLowerCase();
    const feedRound = (px: number) => [1n, BigInt(Math.round(px * 1e8)), 0n, BigInt(Math.floor((NOW - 60_000) / 1000)), 1n] as const;
    const poolDown = {
      async readContract(a: { address: string; functionName: string }) {
        if (a.functionName === "latestRoundData" && a.address.toLowerCase() === usdgFeed) return feedRound(0.97);
        if (a.functionName === "latestRoundData" && a.address.toLowerCase() === usdcFeed) return feedRound(1);
        throw new Error("pool rpc down");
      },
    } as never;
    const cache = memoryMarketDataCache();
    const r = createDepegReader(poolDown, cache, { now: () => NOW });
    expect(await r.chainlinkUsdgUsdcBps()).toMatchObject({ bps: bpsFromPrices(0.97, 1) }); // Chainlink itself is readable
    expect(await r.usdgUsdcBps()).toBeNull(); // no USDC reference mark either
    await cache.putMark("hyperliquid:-:ETH", "2000", iso(NOW - 1000));
    expect(await r.usdgUsdcBps()).toBeNull(); // pool down and no USDG venue mark: unknown, Chainlink notwithstanding
    await cache.putMark("lighter-rh:-:ETH", "2004", iso(NOW - 1000));
    // once a primary reading exists Chainlink may raise it (300 bps is past the band), never replace its source
    expect(await r.usdgUsdcBps()).toMatchObject({ source: "venue_marks", bps: bpsFromPrices(0.97, 1) });
    const rpcDown = { readContract: async () => Promise.reject(new Error("rpc down")) } as never;
    expect(await createDepegReader(rpcDown, cache, { now: () => NOW }).usdgUsdcBps()).toMatchObject({ source: "venue_marks", bps: bpsFromPrices(2000, 2004) });
    // a stale reference mark is not used
    const c2 = memoryMarketDataCache();
    await c2.putMark("hyperliquid:-:ETH", "2000", iso(NOW - 61_000));
    expect(await createDepegReader(rpcDown, c2, { now: () => NOW }).usdgUsdcBps()).toBeNull();
    // the API side reads what the job wrote; nothing written is unknown
    const store = new Map<string, string>();
    const cr = cachedDepegReader({ get: async (k) => store.get(k) ?? null });
    expect(await cr.usdgUsdcBps()).toBeNull();
    store.set(DEPEG_KEYS.usdg, JSON.stringify(reading(3)));
    expect((await cr.usdgUsdcBps())!.bps).toBe(3);
  });

  test("twap-preferred-flag-only", async () => {
    const weth = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
    // a pool at tick T has USDG per WETH = 1.0001^T x 1e12 (token0 WETH 18 dp, token1 USDG 6 dp)
    const tickFor = (usdgPerEth: number) => Math.round(Math.log(usdgPerEth / 1e12) / Math.log(1.0001));
    const fair = tickFor(2000);
    const pumped = tickFor(2100); // a one-block move of 5%
    function rpc(opts: { cardinality: number; observeFails?: boolean; spotTick: number; twapTick: number }) {
      const calls: string[] = [];
      const sqrt = BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, opts.spotTick)) * 2 ** 48)) * 2n ** 48n;
      return {
        calls,
        client: {
          async readContract(a: { functionName: string; args?: unknown[] }) {
            calls.push(a.functionName);
            if (a.functionName === "token0") return weth;
            if (a.functionName === "slot0") return [sqrt, opts.spotTick, 0, opts.cardinality, opts.cardinality, 0, true] as const;
            if (a.functionName === "observe") {
              if (opts.observeFails) throw new Error("OLD");
              return [[0n, BigInt(opts.twapTick) * 300n], [0n, 0n]] as const;
            }
            throw new Error("unexpected");
          },
        } as never,
      };
    }
    const cache = memoryMarketDataCache();
    await cache.putMark("hyperliquid:-:ETH", "2000", iso(NOW - 1000));
    // cardinality covers the window: the 5-minute TWAP is used, so a one-block spot pump changes nothing
    const a = rpc({ cardinality: 100, spotTick: pumped, twapTick: fair });
    const ra = await createDepegReader(a.client, cache, { now: () => NOW }).usdgUsdcBps();
    expect(ra).toMatchObject({ source: "uniswap_v3", method: "twap_5m" });
    expect(Math.abs(ra!.bps)).toBeLessThan(1);
    expect(a.calls).toContain("observe");
    // cardinality 1 (no history) or observe reverting: slot0
    for (const o of [{ cardinality: 1, spotTick: pumped, twapTick: fair }, { cardinality: 50, observeFails: true, spotTick: pumped, twapTick: fair }]) {
      const b = rpc(o);
      const rb = await createDepegReader(b.client, cache, { now: () => NOW }).usdgUsdcBps();
      expect(rb!.method).toBe("slot0");
      expect(rb!.bps).toBeLessThan(-400); // the pumped spot reads as USDG about 4.8% under
    }
    // either way the result only flags: the pumped reading splits groups, every leg stays ok with its own price
    const s = await mixed();
    const pumpedReading = await createDepegReader(rpc({ cardinality: 1, spotTick: pumped, twapTick: fair }).client, cache, { now: () => NOW }).usdgUsdcBps();
    const q = await routeQuote(s.req, deps({ markets: [s.hl, s.rh, s.lt], cache: s.cache, adapters: s.adapters, depeg: depegOf(pumpedReading), now: () => NOW }));
    expect(q.legs.every((l) => l.status === "ok" && l.flags.includes("DEPEG_FLAG"))).toBe(true);
    const before = await routeQuote(s.req, deps({ markets: [s.hl, s.rh, s.lt], cache: s.cache, adapters: s.adapters, depeg: depegOf(reading(0)), now: () => NOW }));
    expect(q.legs.map((l) => [l.marketId, l.avgFillPx, l.sizeBase, l.totalCostBps])).toEqual(before.legs.map((l) => [l.marketId, l.avgFillPx, l.sizeBase, l.totalCostBps]));
    // price helpers agree with each other
    expect(usdgPerEthFromTick(fair, true)).toBeCloseTo(2000, -1);
    const sq = BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, fair)) * 2 ** 48)) * 2n ** 48n;
    expect(usdgPerEthFromSqrt(sq, true) / usdgPerEthFromTick(fair, true)).toBeCloseTo(1, 6);
  });

  test("chainlink-cross-check", async () => {
    const weth = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
    const tickFor = (usdgPerEth: number) => Math.round(Math.log(usdgPerEth / 1e12) / Math.log(1.0001));
    const usdgFeed = ADDRESSES.chainlinkUsdgUsd.address.toLowerCase();
    const usdcFeed = ADDRESSES.chainlinkUsdcUsd.address.toLowerCase();
    // a pool at the given ETH price (slot0 only) and two Chainlink feeds with 8-decimal answers and their update times
    function rpc(o: { poolEth: number; usdg: string; usdc: string; usdgAgeMs?: number; usdcAgeMs?: number }) {
      const tick = tickFor(o.poolEth);
      const sqrt = BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, tick)) * 2 ** 48)) * 2n ** 48n;
      const round = (px: string, age: number) => [1n, BigInt(Math.round(Number(px) * 1e8)), 0n, BigInt(Math.floor((NOW - age) / 1000)), 1n] as const;
      return {
        async readContract(a: { address: string; functionName: string }) {
          if (a.functionName === "token0") return weth;
          if (a.functionName === "slot0") return [sqrt, tick, 0, 1, 1, 0, true] as const;
          if (a.functionName === "latestRoundData") {
            if (a.address.toLowerCase() === usdgFeed) return round(o.usdg, o.usdgAgeMs ?? 3600_000);
            if (a.address.toLowerCase() === usdcFeed) return round(o.usdc, o.usdcAgeMs ?? 3600_000);
          }
          throw new Error(`unexpected ${a.functionName} ${a.address}`);
        },
      } as never;
    }
    const cache = memoryMarketDataCache();
    await cache.putMark("hyperliquid:-:ETH", "2000", iso(NOW - 1000));
    const read = (o: Parameters<typeof rpc>[0]) => createDepegReader(rpc(o), cache, { now: () => NOW }).usdgUsdcBps();

    // the pool says pegged but Chainlink has seen a 60 bps move: the reading is raised to the flag
    const raised = (await read({ poolEth: 2000, usdg: "0.994", usdc: "1" }))!;
    expect(Math.abs(raised.chainlink!.bps + 60)).toBeLessThan(0.5);
    expect(raised.chainlink!.raised).toBe(true);
    expect(raised.bps).toBe(raised.chainlink!.bps);
    expect(raised.source).toBe("uniswap_v3");
    const s = await mixed();
    const q = await routeQuote(s.req, deps({ markets: [s.hl, s.rh, s.lt], cache: s.cache, adapters: s.adapters, depeg: depegOf(raised), now: () => NOW }));
    expect(q.legs.every((l) => l.status === "ok" && l.flags.includes("DEPEG_FLAG"))).toBe(true);
    // Chainlink never lowers or clears: a pool 1% off stays 1% off while Chainlink reads pegged
    const off = (await read({ poolEth: 2020, usdg: "1", usdc: "1" }))!;
    expect(off.bps).toBeLessThan(-90);
    expect(off.chainlink).toMatchObject({ bps: 0, raised: false });
    // inside the 25 bps band Chainlink does not raise anything
    const small = (await read({ poolEth: 2000, usdg: "0.998", usdc: "1" }))!;
    expect(small.chainlink!.raised).toBe(false);
    expect(Math.abs(small.bps)).toBeLessThan(1);
    // a stale feed (older than 24 h + 1 h) is ignored, as is an unreadable one
    for (const o of [{ usdgAgeMs: CHAINLINK_MAX_AGE_MS + 1000 }, { usdcAgeMs: CHAINLINK_MAX_AGE_MS + 1000 }]) {
      const r = (await read({ poolEth: 2000, usdg: "0.9", usdc: "1", ...o }))!;
      expect(r.chainlink).toBeUndefined();
      expect(Math.abs(r.bps)).toBeLessThan(1);
    }
    // Chainlink on its own never makes a reading: no USDC reference is still unknown (fail closed)
    const bare = memoryMarketDataCache();
    expect(await createDepegReader(rpc({ poolEth: 2000, usdg: "0.9", usdc: "1" }), bare, { now: () => NOW }).usdgUsdcBps()).toBeNull();
    // the merge rule itself
    const base: DepegReading = { bps: 30, asOf: NOW, source: "uniswap_v3" };
    expect(applyChainlinkCrossCheck(base, { bps: 0, updatedAt: NOW }).bps).toBe(30);
    expect(applyChainlinkCrossCheck(base, { bps: -70, updatedAt: NOW }).bps).toBe(-70);
    expect(applyChainlinkCrossCheck(base, null)).toEqual(base);
  });
});
