// R9 QUOTE-1: for every venue, the quote's size, limit price and fee columns equal what that venue adapter's own
// buildOrder builds for the same intent at the same instant on the same cached book.
// Aster and Hyperliquid (core and HIP-3) run through the real adapter object's buildOrder. Lighter (mainnet 304 and
// Robinhood Chain) runs through adapter-lighter's exported buildOrder, the function the adapter method hands its
// inputs to: the adapter method itself also seeds a nonce over HTTP and reads market meta whose executable flag only a
// catalog review sets, so this test passes the same inputs the method would (meta, the cached book, the fee row).
import { describe, expect, test } from "bun:test";
import { createAdapter as createAsterAdapter, ASTER_MAINNET, type AsterReader } from "@capstan/adapter-aster";
import { createAdapter as createHlAdapter, createHip3Gate, createHip3Hook, HL_MAINNET, type HlMarket, type HlReader } from "@capstan/adapter-hyperliquid";
import { buildOrder as lighterBuildOrder, createLighterAdapter, docsSchedule, feeFor, LIGHTER_CONFIGS, type LighterMarketMeta } from "@capstan/adapter-lighter";
import { CapstanError, Dec, type BuildContext, type Hex, type QuoteRequest, type VenueId } from "@capstan/schema";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";
import { intentForLeg, quoteBuildDiffs } from "../src/conformance";
import { defaultBuilderFeeBps } from "../src/fees";
import { routeQuote, type QuoteAdapter } from "../src/route";
import { deps, funding, marketFor, recorded, staticCache, type BookSet, type RecordedBook } from "./helpers";

const OWNER = "0x3333333333333333333333333333333333333333" as Hex;
const AGENT = "0x4444444444444444444444444444444444444444" as Hex;
const BUILDER = "0x5555555555555555555555555555555555555555" as Hex;

/** A size just past the venue grid (adds 0.000000037), so the floor to the lot has work to do. */
const offGrid = (size: string) => Dec.toString(Dec.add(Dec.parse(size, 18), Dec.parse("0.000000037", 18)));

function ctx(nowMs: number, lock: boolean): BuildContext {
  return {
    owner: OWNER,
    agentRef: `aster:${OWNER}:${AGENT}`,
    identity: { venue: "aster", owner: OWNER, agentAddress: AGENT },
    builderFee: { decimalRate: lock ? "0.0001" : "0.0002" },
    approvedMaxBps: 3,
    nowMs,
    eligibilityDecisionId: "elig_q1",
    policyId: null,
  };
}

describe("quote1", () => {
  test("quote-equals-build", async () => {
    const books = recorded("aster");
    let compared = 0;
    let skippedMinNotional = 0;
    let okLegs = 0;
    for (let i = 0; i < books.length; i++) {
      const r = books[i]!;
      const m = marketFor("aster", r);
      const now = Date.parse(r.book.asOf) + 400;
      const cache = staticCache();
      await cache.putBook({ marketId: m.id, ...r.book });
      await cache.putFunding(funding(m.id, "0.00001", new Date(now).toISOString()));
      const reader = { listMarkets: async () => [m], getBook: async () => (await cache.getBook(m.id))!, getFunding: async () => (await cache.getFunding(m.id))! } as unknown as AsterReader;
      const http = venueHttp("aster", "http://aster.invalid", createMemoryGovernor("q1"), { fetchImpl: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch });
      const adapter = createAsterAdapter({ ...ASTER_MAINNET, builder: BUILDER, execution: true }, { http, cache, reader, now: () => now });
      const quoteAdapter: QuoteAdapter = adapter;
      for (const side of ["buy", "sell"] as const) {
        const levels = side === "buy" ? r.book.asks : r.book.bids;
        if (levels.length < 3) continue;
        const size = levels.slice(0, 2).map(([, s]) => s).reduce((a, b) => Dec.toString(Dec.add(Dec.parse(a, 18), Dec.parse(b, 18))));
        for (const orderType of ["market", "limit"] as const) {
          for (const lock of [false, true]) {
            const req: QuoteRequest = { marketIds: [m.id], side, sizeBase: size, leverage: 2, holdHours: 1, orderType, ...(orderType === "limit" ? { limitPx: levels[2]![0] } : {}), owner: OWNER };
            const q = await routeQuote(req, deps({ markets: [m], cache, adapters: new Map<VenueId, QuoteAdapter>([["aster", quoteAdapter]]), builderFeeBps: defaultBuilderFeeBps({ lockTier: () => lock }), now: () => now }));
            const leg = q.legs[0]!;
            // a thin book still has a shape: the build is made (with a warning) and must match it too
            expect(["ok", "insufficient_depth"]).toContain(leg.status);
            expect(leg.limitPx).not.toBeNull();
            if (leg.status === "ok") okLegs++;
            let build;
            try {
              build = await adapter.buildOrder(intentForLeg(req, leg), ctx(now, lock));
            } catch (e) {
              if (e instanceof CapstanError && /under the venue minimum/.test(e.message)) {
                skippedMinNotional++;
                continue;
              }
              throw e;
            }
            expect(quoteBuildDiffs(leg, build)).toEqual([]);
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(120);
    expect(okLegs).toBeGreaterThanOrEqual(100);
    expect(skippedMinNotional).toBeLessThan(40);
  });

  test("quote-equals-build hyperliquid", async () => {
    // core BTC and HIP-3 xyz books; three mark states per book: none, fresh (the build and the quote both use it as the
    // reference) and stale (both fall back to the book mid)
    const gate = createHip3Gate({});
    let compared = 0;
    let hip3 = 0;
    let withMark = 0;
    for (const set of ["hyperliquid-core", "hyperliquid-xyz"] as const) {
      const books = recorded(set);
      for (let i = 0; i < books.length; i++) {
        const r = books[i]!;
        const m = marketFor(set, r);
        const szDecimals = Number(r.meta.szDecimals);
        const hm: HlMarket = { ...m, szDecimals, pxDecimalsMax: 6 - szDecimals, assetId: m.dex ? 110_000 + i : i, dexIndex: m.dex ? 1 : 0, onlyIsolated: false };
        const now = Date.parse(r.book.asOf) + 400;
        const markState = i % 3; // 0 none, 1 fresh, 2 stale
        const cache = staticCache();
        await cache.putBook({ marketId: m.id, ...r.book });
        await cache.putFunding(funding(m.id, "0.00001", new Date(now).toISOString()));
        if (markState > 0 && r.book.bids[0]) await cache.putMark(m.id, r.book.bids[0][0], new Date(now - (markState === 1 ? 1000 : 5000)).toISOString());
        const reader = {
          instrument: async () => hm,
          listMarkets: async () => [hm],
          getBook: async () => (await cache.getBook(m.id))!,
          getFunding: async () => (await cache.getFunding(m.id))!,
          maxBuilderFee: async () => 30,
          userFees: async () => {
            throw new Error("keyless test: base tier");
          },
          metaAndAssetCtxs: async () => [{ universe: [{ name: r.venueSymbol }] }, [{ openInterest: "0", markPx: r.book.bids[0]?.[0] ?? "1" }]],
          dexAccount: async () => ({ withdrawable: "1000000000" }),
        } as unknown as HlReader;
        const http = venueHttp("hyperliquid", "http://hl.invalid", createMemoryGovernor("q1hl"), { fetchImpl: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch });
        const hook = createHip3Hook({ reader, gate, isExecutable: () => true, eqExecutionAllowed: () => true });
        const adapter = createHlAdapter({ ...HL_MAINNET, builderAddress: BUILDER }, { http, cache, reader, now: () => now, enabled: () => true, isExecutable: () => true, hip3: hook });
        for (const side of ["buy", "sell"] as const) {
          const levels = side === "buy" ? r.book.asks : r.book.bids;
          if (levels.length < 3) continue;
          const onGrid = levels.slice(0, 2).map(([, sz]) => sz).reduce((a, b) => Dec.toString(Dec.add(Dec.parse(a, 18), Dec.parse(b, 18))));
          // the second size is off the venue grid, so the size rounding is compared too
          for (const [size, orderType, lock] of [onGrid, offGrid(onGrid)].flatMap((sz) => (["market", "limit"] as const).flatMap((t) => [false, true].map((l) => [sz, t, l] as const)))) {
            const req: QuoteRequest = { marketIds: [m.id], side, sizeBase: size, leverage: 2, holdHours: 1, orderType, ...(orderType === "limit" ? { limitPx: levels[2]![0] } : {}), owner: OWNER };
            const q = await routeQuote(req, deps({ markets: [m], cache, adapters: new Map<VenueId, QuoteAdapter>([["hyperliquid", adapter]]), builderFeeBps: defaultBuilderFeeBps({ lockTier: () => lock, hip3BuilderFeeSupported: gate.builderFeeSupported }), now: () => now }));
            const leg = q.legs[0]!;
            expect(["ok", "insufficient_depth"]).toContain(leg.status);
            expect(leg.limitPx).not.toBeNull();
            const build = await adapter.buildOrder(intentForLeg(req, leg), {
              owner: OWNER,
              agentRef: `hyperliquid:${OWNER}:${AGENT}`,
              identity: { venue: "hyperliquid", owner: OWNER, agentAddress: AGENT },
              builderFee: { tenthsBp: lock ? 10 : 20 },
              approvedMaxBps: 3,
              nowMs: now,
              eligibilityDecisionId: "elig_q1",
              policyId: null,
            });
            expect(quoteBuildDiffs(leg, build)).toEqual([]);
            compared++;
            if (m.dex) hip3++;
            if (markState === 1) withMark++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(480);
    expect(hip3).toBeGreaterThanOrEqual(240);
    expect(withMark).toBeGreaterThanOrEqual(80);
  });

  for (const set of ["lighter-mainnet", "lighter-rh"] as const) {
    test(`quote-equals-build ${set}`, async () => {
      const cfg = LIGHTER_CONFIGS[set === "lighter-rh" ? "rh" : "mainnet"];
      const fee = feeFor(docsSchedule(cfg.venue), null); // the adapter's fee row for a keyless owner (Standard)
      const hasher = { txHashForOrder: async () => "ab".repeat(32), txHashForCancel: async () => "cd".repeat(32) };
      let compared = 0;
      let skippedMin = 0;
      let okLegs = 0;
      let withMark = 0;
      const books = recorded(set as BookSet);
      for (let i = 0; i < books.length; i++) {
        const r: RecordedBook = books[i]!;
        const m = marketFor(set, r);
        const now = Date.parse(r.book.asOf) + 400;
        // three mark states per book: none, fresh and stale. The mark sits off both best prices (the second bid
        // level), so a quote that preferred the mark over the best price would no longer equal the build, which
        // prices off the best price and falls back to the venue mark only on an empty side
        const markState = i % 3;
        const markPx = markState > 0 ? (r.book.bids[1]?.[0] ?? null) : null;
        const meta: LighterMarketMeta = { market: m, marketIndex: Number(r.meta.marketIndex), sizeDecimals: Number(r.meta.sizeDecimals), priceDecimals: Number(r.meta.priceDecimals), minBaseAmount: (r.meta.minBaseAmount as string | null) ?? null, markPx: markPx ?? (r.meta.markPx as string | null) ?? null, imfTicks: Number(r.meta.imf), capPerHour: null };
        const cache = staticCache();
        await cache.putBook({ marketId: m.id, ...r.book });
        if (markPx) await cache.putMark(m.id, markPx, new Date(now - (markState === 1 ? 1000 : 5000)).toISOString());
        await cache.putFunding(funding(m.id, "0.00001", new Date(now).toISOString()));
        const http = venueHttp(cfg.governorKey, "http://lighter.invalid", createMemoryGovernor("q1l"), { fetchImpl: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch });
        const adapter = createLighterAdapter(cfg, { http, cache, execution: true, hasher, now: () => now });
        for (const side of ["buy", "sell"] as const) {
          const levels = side === "buy" ? r.book.asks : r.book.bids;
          if (levels.length < 3) continue;
          const onGrid = levels.slice(0, 2).map(([, sz]) => sz).reduce((a, b) => Dec.toString(Dec.add(Dec.parse(a, 18), Dec.parse(b, 18))));
          for (const [size, orderType] of [onGrid, offGrid(onGrid)].flatMap((sz) => (["market", "limit"] as const).map((t) => [sz, t] as const))) {
            const req: QuoteRequest = { marketIds: [m.id], side, sizeBase: size, leverage: 2, holdHours: 1, orderType, ...(orderType === "limit" ? { limitPx: levels[2]![0] } : {}), owner: OWNER };
            const q = await routeQuote(req, deps({ markets: [m], cache, adapters: new Map<VenueId, QuoteAdapter>([[cfg.venue, adapter]]), now: () => now }));
            const leg = q.legs[0]!;
            expect(["ok", "insufficient_depth"]).toContain(leg.status);
            expect(leg.limitPx).not.toBeNull();
            if (leg.status === "ok") okLegs++;
            // the adapter method reads the book through its reader: cache first, 50 levels
            const cached = (await cache.getBook(m.id))!;
            const book = { ...cached, bids: cached.bids.slice(0, 50), asks: cached.asks.slice(0, 50) };
            const id = { venue: cfg.venue, owner: OWNER, accountIndex: 99, apiKeyIndex: 4 };
            let build;
            try {
              build = await lighterBuildOrder(intentForLeg(req, leg), { owner: OWNER, agentRef: `${cfg.venue}:99:4`, identity: id, builderFee: null, approvedMaxBps: null, nowMs: now, eligibilityDecisionId: "elig_q1", policyId: null, cfg, market: { ...meta, market: { ...meta.market, executable: true } }, book, fee, hasher, integratorAccountIndex: 0, nonce: 1 + compared, clientOrderIndex: 1 + compared });
            } catch (e) {
              if (e instanceof CapstanError && /below the market minimum/.test(e.message)) {
                skippedMin++;
                continue;
              }
              throw e;
            }
            expect(quoteBuildDiffs(leg, build)).toEqual([]);
            compared++;
            if (markState === 1 && markPx) withMark++;
          }
        }
      }
      expect(compared).toBeGreaterThanOrEqual(120);
      expect(withMark).toBeGreaterThanOrEqual(30);
      expect(okLegs).toBeGreaterThanOrEqual(100);
      expect(skippedMin).toBeLessThan(20);
    });
  }
});
