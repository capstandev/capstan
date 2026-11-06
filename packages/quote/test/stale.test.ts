// Staleness and cross-check rules R3, R4, R15 (todo 17).
import { describe, expect, test } from "bun:test";
import type { VenueId } from "@capstan/schema";
import { routeQuote, STALE_MS, type QuoteAdapter } from "../src/route";
import { cacheAdapter, deps, funding, genericMarket, ladder, staticCache } from "./helpers";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ro = (venue: "variational" | "arcus", markAge: number, mark: string): QuoteAdapter => ({
  caps: { venue, execution: false, keyType: null, delegation: "none", canWithdraw: false, builderFee: null, collateral: ["USDC"], directSubmitSupported: false, publicAccountReads: false },
  getBook: async () => null,
  getFunding: async (id) => funding(id, "0", iso(NOW - markAge)),
  getMark: async () => ({ mark, asOf: iso(NOW - markAge) }),
});

describe("stale", () => {
  test("t1-3s", async () => {
    expect(STALE_MS.t1).toBe(3000);
    const cache = staticCache();
    const m = genericMarket("hyperliquid:-:ETH", "hyperliquid", { lotSize: "0.0001" });
    await cache.putFunding(funding(m.id, "0", iso(NOW)));
    const req = { marketIds: [m.id], side: "buy" as const, sizeBase: "1", leverage: 2, holdHours: 0, orderType: "market" as const };
    for (const [age, status] of [
      [0, "ok"],
      [2999, "ok"],
      [3000, "ok"],
      [3001, "refused"],
      [60_000, "refused"],
    ] as const) {
      await cache.putBook(ladder(m.id, "2000", "0.5", "5", iso(NOW - age)));
      const q = await routeQuote(req, deps({ markets: [m], cache, now: () => NOW }));
      const leg = q.legs[0]!;
      expect(leg.status).toBe(status);
      expect(leg.staleMs).toBe(age);
      if (status === "refused") {
        expect(leg.refusal!.code).toBe("STALE_QUOTE");
        expect(leg.avgFillPx).toBe("0"); // never silently priced from the old book
        expect(q.best).toBeNull();
      }
    }
    // clock skew: a book dated in the future is as stale as it is far ahead, never fresher than now
    for (const [ahead, status] of [
      [1000, "ok"],
      [3000, "ok"],
      [3001, "refused"],
      [60_000, "refused"],
    ] as const) {
      await cache.putBook(ladder(m.id, "2000", "0.5", "5", iso(NOW + ahead)));
      const q = await routeQuote(req, deps({ markets: [m], cache, now: () => NOW }));
      expect(q.legs[0]!.status).toBe(status);
      expect(q.legs[0]!.staleMs).toBe(ahead);
      if (status === "refused") expect(q.legs[0]!.refusal!.code).toBe("STALE_QUOTE");
    }
    // a funding snapshot dated hours ahead is refused like an old one
    await cache.putBook(ladder(m.id, "2000", "0.5", "5", iso(NOW - 10)));
    await cache.putFunding(funding(m.id, "0.0001", iso(NOW + 2 * 3600_000 + 1)));
    expect((await routeQuote({ ...req, holdHours: 4 }, deps({ markets: [m], cache, now: () => NOW }))).legs[0]!.refusal!.code).toBe("STALE_QUOTE");
    await cache.putFunding(funding(m.id, "0", iso(NOW)));
    // no book at all: refused, never guessed
    const empty = staticCache();
    const q = await routeQuote(req, deps({ markets: [m], cache: empty, now: () => NOW }));
    expect(q.legs[0]!.refusal!.code).toBe("STALE_QUOTE");
    // a funding snapshot over 2 h old refuses the leg when funding matters
    await cache.putBook(ladder(m.id, "2000", "0.5", "5", iso(NOW - 10)));
    await cache.putFunding(funding(m.id, "0.0001", iso(NOW - 2 * 3600_000 - 1)));
    const q2 = await routeQuote({ ...req, holdHours: 4 }, deps({ markets: [m], cache, now: () => NOW }));
    expect(q2.legs[0]!.refusal!.code).toBe("STALE_QUOTE");
    await cache.putFunding(funding(m.id, "0.0001", iso(NOW - 3600_000)));
    const q3 = await routeQuote({ ...req, holdHours: 4 }, deps({ markets: [m], cache, now: () => NOW }));
    expect(q3.legs[0]!).toMatchObject({ status: "ok", fundingStaleMs: 3600_000, fundingCostBps: 4 });
  });

  async function crossSetup(variationalAge: number, variationalMark: string, arcusAge: number, arcusMark: string) {
    const cache = staticCache();
    const hl = genericMarket("hyperliquid:-:ETH", "hyperliquid", { lotSize: "0.0001" });
    const va = genericMarket("variational:-:ETH-PERP", "variational");
    const ar = genericMarket("arcus:-:ETH-USD", "arcus");
    await cache.putBook(ladder(hl.id, "2000", "0.5", "5", iso(NOW - 100)));
    await cache.putMark(hl.id, "2000", iso(NOW - 100));
    await cache.putFunding(funding(hl.id, "0", iso(NOW)));
    const adapters = new Map<VenueId, QuoteAdapter>([
      ["hyperliquid", cacheAdapter("hyperliquid", cache)],
      ["variational", ro("variational", variationalAge, variationalMark)],
      ["arcus", ro("arcus", arcusAge, arcusMark)],
    ]);
    const req = { marketIds: [hl.id], side: "buy" as const, sizeBase: "1", leverage: 2, holdHours: 0, orderType: "market" as const };
    return routeQuote(req, deps({ markets: [hl, va, ar], cache, adapters, now: () => NOW }));
  }

  test("variational-cross-check", async () => {
    expect(STALE_MS.variationalCrossCheck).toBe(120_000);
    // 60 s old (normal for its CDN): used for the cross-check; 1% away flags 100 bps
    let q = await crossSetup(60_000, "2020", 60_000, "2000");
    expect(q.legs[0]!).toMatchObject({ status: "ok", markDivergenceBps: 99.0099, markDivergenceSource: "variational" });
    // within 50 bps: no flag
    q = await crossSetup(60_000, "2009", 60_000, "2000");
    expect(q.legs[0]!.markDivergenceBps).toBeNull();
    // 121 s old: too old even for the cross-check; nothing computed (warn-only input), the leg is still ok
    q = await crossSetup(121_000, "2020", 60_000, "2000");
    expect(q.legs[0]!).toMatchObject({ status: "ok", markDivergenceBps: null });
    // a Variational leg itself is never refused for its age: its staleMs is the real age (see route.test)
  });

  test("arcus-cross-check", async () => {
    // Arcus under 10 s and 1% away: flagged with source arcus; Variational agrees
    let q = await crossSetup(30_000, "2000", 5_000, "1980");
    expect(q.legs[0]!).toMatchObject({ status: "ok", markDivergenceSource: "arcus" });
    expect(q.legs[0]!.markDivergenceBps).toBeGreaterThan(50);
    // Arcus 11 s old: skipped
    q = await crossSetup(30_000, "2000", 11_000, "1980");
    expect(q.legs[0]!.markDivergenceBps).toBeNull();
    // the larger divergence wins when both flag
    q = await crossSetup(30_000, "2030", 5_000, "1990");
    expect(q.legs[0]!.markDivergenceSource).toBe("variational");
    expect(q.best).toBe("hyperliquid:-:ETH"); // a divergence flags, it does not refuse
  });
});
