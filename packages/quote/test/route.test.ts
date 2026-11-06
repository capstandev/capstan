// Routing rules R2, R8, R11, R13 (todo 17).
import { describe, expect, test } from "bun:test";
import type { VenueId } from "@capstan/schema";
import { routeQuote, REFUSED_REGION_REASON, type QuoteAdapter } from "../src/route";
import { cacheAdapter, deps, funding, genericMarket, ladder, staticCache } from "./helpers";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

async function setup() {
  const cache = staticCache();
  const hl = genericMarket("hyperliquid:-:ETH", "hyperliquid", { lotSize: "0.0001", maxLeverage: 25 });
  const lt = genericMarket("lighter-mainnet:-:ETH", "lighter-mainnet", { lotSize: "0.0001", tickSize: "0.01", maxLeverage: 25, maintenanceMarginFraction: "0.012" });
  const ar = genericMarket("arcus:-:ETH-USD", "arcus", { lotSize: "0.0001" });
  const va = genericMarket("variational:-:ETH-PERP", "variational", { lotSize: "0" });
  await cache.putBook(ladder(hl.id, "2000", "0.5", "5", iso(NOW - 200)));
  await cache.putBook(ladder(lt.id, "2000", "0.4", "5", iso(NOW - 200)));
  // Arcus is the cheapest book of all, by far
  await cache.putBook(ladder(ar.id, "2000", "0.01", "100", iso(NOW - 200)));
  for (const m of [hl, lt, ar, va]) await cache.putFunding(funding(m.id, "0.00001", iso(NOW - 5000)));
  await cache.putMark(va.id, "2000", iso(NOW - 40_000));
  const variational: QuoteAdapter = {
    caps: { venue: "variational", execution: false, keyType: null, delegation: "none", canWithdraw: false, builderFee: null, collateral: ["USDC"], directSubmitSupported: false, publicAccountReads: false },
    getBook: async () => null,
    getFunding: async (id) => funding(id, "0.00001", iso(NOW - 40_000)),
    getQuoteBuckets: async () => [
      { size: "1k", bid: "1999.99", ask: "2000.01", asOf: iso(NOW - 40_000) },
      { size: "100k", bid: "1999.9", ask: "2000.1", asOf: iso(NOW - 40_000) },
    ],
    getMark: async () => ({ mark: "2000", asOf: iso(NOW - 40_000) }),
  };
  const arcus: QuoteAdapter = { ...variational, caps: { ...variational.caps, venue: "arcus", collateral: ["USDG"] }, getBook: (id: string) => cache.getBook(id), getQuoteBuckets: undefined, getMark: undefined };
  const adapters = new Map<VenueId, QuoteAdapter>([
    ["hyperliquid", cacheAdapter("hyperliquid", cache)],
    ["lighter-mainnet", cacheAdapter("lighter-mainnet", cache)],
    ["arcus", arcus],
    ["variational", variational],
  ]);
  return { cache, hl, lt, ar, va, adapters };
}

describe("route", () => {
  test("data-only-never-best", async () => {
    const s = await setup();
    // pegged USDG reading so the comparison is not split by collateral
    const depeg = { usdgUsdcBps: async () => ({ bps: 1, asOf: NOW - 1000, source: "uniswap_v3" as const }), usdtUsdcBps: async () => null };
    // Arcus at a zero fee tier with the deepest book: the cheapest leg on every column
    const feeTier = async (_o: unknown, v: VenueId) => ({ takerBps: v === "arcus" ? 0 : v === "hyperliquid" ? 4.5 : 0, source: "owner" as const });
    const q = await routeQuote({ canonicalAsset: "CR:ETH", side: "buy", sizeBase: "8", leverage: 5, holdHours: 1, orderType: "market" }, deps({ markets: [s.hl, s.lt, s.ar, s.va], cache: s.cache, adapters: s.adapters, depeg, feeTier, now: () => NOW }));
    const by = Object.fromEntries(q.legs.map((l) => [l.venue, l]));
    expect(by.arcus!.status).toBe("data_only");
    expect(by.variational!.status).toBe("data_only");
    // Arcus really is the cheapest leg, and still never best
    expect(by.arcus!.totalCostBps).toBeLessThan(by["lighter-mainnet"]!.totalCostBps);
    expect(by.arcus!.totalCostBps).toBeLessThan(by.hyperliquid!.totalCostBps);
    expect(q.best).not.toBe(s.ar.id);
    expect(q.best).not.toBe(s.va.id);
    expect(["ok"]).toContain(q.legs.find((l) => l.marketId === q.best)!.status);
    // ranking: ok legs first (cheapest first), then data_only
    const st = q.ranking.map((id) => q.legs.find((l) => l.marketId === id)!.status);
    expect(st).toEqual(["ok", "ok", "data_only", "data_only"]);
    const okLegs = q.ranking.slice(0, 2).map((id) => q.legs.find((l) => l.marketId === id)!.totalCostBps);
    expect(okLegs[0]!).toBeLessThanOrEqual(okLegs[1]!);
    // Variational shows its bucket price and its real age (40 s), and is not refused for it
    expect(by.variational!.avgFillPx).toBe("2000.1"); // 16,000 USD notional: the 100k bucket
    expect(by.variational!.staleMs).toBe(40_000);
    expect(by.variational!.dataFreshness).toBe("delayed");
    // only data-only legs, cheapest or not: best is null
    const q2 = await routeQuote({ marketIds: [s.ar.id, s.va.id], side: "buy", sizeBase: "2", leverage: 5, holdHours: 1, orderType: "market" }, deps({ markets: [s.ar, s.va], cache: s.cache, adapters: s.adapters, depeg, now: () => NOW }));
    expect(q2.best).toBeNull();
  });

  test("insufficient-depth", async () => {
    const s = await setup();
    // too large for the book (10 levels x 5)
    const q = await routeQuote({ marketIds: [s.hl.id], side: "buy", sizeBase: "60", leverage: 5, holdHours: 0, orderType: "market" }, deps({ markets: [s.hl], cache: s.cache, now: () => NOW }));
    expect(q.legs[0]!.status).toBe("insufficient_depth");
    expect(q.best).toBeNull();
    // fits the book but the protective limit (50 bps = 10 USD) stops the walk: also insufficient
    const thin = genericMarket("hyperliquid:-:SOL", "hyperliquid", { lotSize: "0.01", canonicalAsset: "CR:SOL" });
    await s.cache.putBook(ladder(thin.id, "100", "0.2", "1", iso(NOW - 100), 10));
    const q1 = await routeQuote({ marketIds: [thin.id], side: "buy", sizeBase: "6", leverage: 2, holdHours: 0, orderType: "market" }, deps({ markets: [thin], cache: s.cache, now: () => NOW }));
    expect(q1.legs[0]!.status).toBe("insufficient_depth");
    // HIP-3 OI cap: 2 ETH x ~2000 = ~4,000 USD notional; cap 1,000,000 with 999,000 already open breaches
    const capped = genericMarket("hyperliquid:xyz:ETH", "hyperliquid", { lotSize: "0.0001", oiCapUsd: "1000000", deployerFeeScale: "1.0", growthMode: false });
    await s.cache.putBook({ ...ladder(capped.id, "2000", "0.5", "5", iso(NOW - 100)) });
    await s.cache.putFunding(funding(capped.id, "0", iso(NOW - 100)));
    const oi = (v: string) => async () => v;
    const breach = await routeQuote({ marketIds: [capped.id], side: "buy", sizeBase: "2", leverage: 2, holdHours: 0, orderType: "market" }, deps({ markets: [capped], cache: s.cache, openInterestUsd: oi("999000"), now: () => NOW }));
    expect(breach.legs[0]!.status).toBe("insufficient_depth");
    const fits = await routeQuote({ marketIds: [capped.id], side: "buy", sizeBase: "2", leverage: 2, holdHours: 0, orderType: "market" }, deps({ markets: [capped], cache: s.cache, openInterestUsd: oi("100000"), now: () => NOW }));
    expect(fits.legs[0]!.status).toBe("ok");
  });

  test("refused-leg", async () => {
    const s = await setup();
    const owner = "0x1111111111111111111111111111111111111111" as const;
    const eligibility = async (_o: unknown, venue: VenueId) => (venue === "hyperliquid" ? { allowed: false, code: "GEO_REFUSED" as const, decisionId: "d1" } : { allowed: true });
    const q = await routeQuote({ marketIds: [s.hl.id, s.lt.id], side: "sell", sizeBase: "1", leverage: 3, holdHours: 2, orderType: "market", owner }, deps({ markets: [s.hl, s.lt], cache: s.cache, eligibility, now: () => NOW }));
    const hl = q.legs.find((l) => l.venue === "hyperliquid")!;
    expect(hl.status).toBe("refused");
    expect(hl.refusal).toEqual({ code: "GEO_REFUSED", reason: REFUSED_REGION_REASON });
    expect(REFUSED_REGION_REASON).toBe("not available in your region");
    expect(q.best).toBe(s.lt.id);
    // without an owner, no eligibility is asked and both legs quote
    const q2 = await routeQuote({ marketIds: [s.hl.id, s.lt.id], side: "sell", sizeBase: "1", leverage: 3, holdHours: 2, orderType: "market" }, deps({ markets: [s.hl, s.lt], cache: s.cache, eligibility, now: () => NOW }));
    expect(q2.legs.every((l) => l.status === "ok")).toBe(true);
    // a market the catalog has not made executable is refused, never quoted as ok
    const off = { ...s.hl, executable: false };
    const q3 = await routeQuote({ marketIds: [off.id], side: "sell", sizeBase: "1", leverage: 3, holdHours: 0, orderType: "market" }, deps({ markets: [off], cache: s.cache, now: () => NOW }));
    expect(q3.legs[0]!.refusal!.code).toBe("MARKET_NOT_EXECUTABLE");
  });

  test("no-cross-venue-sum", async () => {
    const s = await setup();
    const q = await routeQuote({ canonicalAsset: "CR:ETH", side: "buy", notionalUsd: "1000", leverage: 2, holdHours: 4, orderType: "market" }, deps({ markets: [s.hl, s.lt, s.ar, s.va], cache: s.cache, adapters: s.adapters, now: () => NOW }));
    for (const l of q.legs) expect(typeof l.collateralAsset).toBe("string");
    expect(q.legs.find((l) => l.venue === "arcus")!.collateralAsset).toBe("USDG");
    expect(q.legs.find((l) => l.venue === "hyperliquid")!.collateralAsset).toBe("USDC");
    // no field anywhere sums cost, margin or collateral across venues: only per-leg totalCostBps
    const keys: string[] = [];
    const walk = (o: unknown, path: string) => {
      if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) (keys.push(`${path}.${k}`), walk(v, `${path}.${k}`));
    };
    walk(q, "q");
    const suspicious = keys.filter((k) => /total|sum|aggregate|combined|net|margin/i.test(k.split(".").pop()!));
    expect([...new Set(suspicious.map((k) => k.split(".").pop()))]).toEqual(["totalCostBps"]);
    expect(keys.filter((k) => k.endsWith("totalCostBps")).every((k) => /^q\.legs\.\d+\.totalCostBps$/.test(k))).toBe(true);
    // notional sizing: 1000 USD at the best ask, floored to the lot
    const hl = q.legs.find((l) => l.venue === "hyperliquid")!;
    expect(hl.sizeBase).toBe("0.4998");
    // the snapshot hash: a JCS sha256 the route stores as receiptHint
    expect(q.receiptHint).toMatch(/^0x[0-9a-f]{64}$/);
    expect(q.fundingNote).toBe("Funding is observed and changes hourly.");
  });
});
