// R10: fee columns. Builder: HL 2 bps (1 bp lock tier), Aster 2 bps (1 bp), Lighter 0, HIP-3 2 bps (DECISIONS #31) and 0 on a dex the gate switched off;
// venue fee from the owner's tier when known, else base.
import { describe, expect, test } from "bun:test";
import type { VenueId } from "@capstan/schema";
import { BASE_TAKER_BPS, baseFeeTier, defaultBuilderFeeBps, hip3TakerBps } from "../src/fees";
import { routeQuote } from "../src/route";
import { deps, funding, genericMarket, ladder, staticCache } from "./helpers";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("fees", () => {
  test("columns", async () => {
    const owner = "0x2222222222222222222222222222222222222222" as const;
    const std = defaultBuilderFeeBps();
    const lock = defaultBuilderFeeBps({ lockTier: () => true });
    const gate = defaultBuilderFeeBps({ hip3BuilderFeeSupported: (dex) => dex !== "xyz" });
    const core = { dex: null };
    const hip3 = { dex: "xyz" };
    expect(await std(owner, "hyperliquid", core)).toBe(2);
    expect(await lock(owner, "hyperliquid", core)).toBe(1);
    expect(await std(owner, "aster")).toBe(2);
    expect(await lock(owner, "aster")).toBe(1);
    expect(await std(owner, "lighter-mainnet")).toBe(0);
    expect(await lock(owner, "lighter-rh")).toBe(0);
    expect(await std(owner, "hyperliquid", hip3)).toBe(2);
    expect(await lock(owner, "hyperliquid", hip3)).toBe(1);
    expect(await gate(owner, "hyperliquid", hip3)).toBe(0);
    expect(await gate(owner, "hyperliquid", { dex: "io" })).toBe(2);
    expect(await std(owner, "arcus")).toBe(0);
    expect(await std(owner, "variational")).toBe(0);
    // venue fee: base when the owner is unknown
    for (const v of Object.keys(BASE_TAKER_BPS) as VenueId[]) expect((await baseFeeTier(undefined, v)).takerBps).toBe(BASE_TAKER_BPS[v]);
    expect(BASE_TAKER_BPS).toMatchObject({ hyperliquid: 4.5, aster: 3.5, "lighter-mainnet": 0, "lighter-rh": 0, arcus: 4.5 });
    // HIP-3: scale 1 doubles the core fee (xyz:GOLD paid 9 bps); growth mode is a tenth; scale 2 = 3 + ... (max(1,s)+s)
    expect(hip3TakerBps(4.5, { deployerFeeScale: "1.0", growthMode: false })).toBe(9);
    expect(hip3TakerBps(4.5, { deployerFeeScale: "1.0", growthMode: true })).toBe(0.9);
    expect(hip3TakerBps(4.5, { deployerFeeScale: "0", growthMode: true })).toBe(0.45);
    expect(hip3TakerBps(4.5, { deployerFeeScale: "3", growthMode: false })).toBe(27);

    // in the engine: the owner's tier wins over base, builder from the function given
    const cache = staticCache();
    const hl = genericMarket("hyperliquid:-:ETH", "hyperliquid", { lotSize: "0.0001" });
    const as = genericMarket("aster:-:ETHUSDT", "aster", { lotSize: "0.001", tickSize: "0.01" });
    for (const m of [hl, as]) {
      await cache.putBook(ladder(m.id, "2000", "0.5", "5", iso(NOW - 10)));
      await cache.putFunding(funding(m.id, "0", iso(NOW)));
    }
    const req = { marketIds: [hl.id, as.id], side: "buy" as const, sizeBase: "1", leverage: 2, holdHours: 0, orderType: "market" as const };
    const base = await routeQuote(req, deps({ markets: [hl, as], cache, now: () => NOW }));
    expect(base.legs.map((l) => [l.venueFeeBps, l.builderFeeBps])).toEqual([
      [4.5, 2],
      [3.5, 2],
    ]);
    const tiered = await routeQuote({ ...req, owner }, deps({ markets: [hl, as], cache, feeTier: async (_o, v) => ({ takerBps: v === "hyperliquid" ? 3 : 3.2, source: "owner" }), builderFeeBps: lock, now: () => NOW }));
    expect(tiered.legs.map((l) => [l.venueFeeBps, l.builderFeeBps])).toEqual([
      [3, 1],
      [3.2, 1],
    ]);
    // totals add the columns exactly
    for (const l of tiered.legs) expect(l.totalCostBps).toBe(Math.round((l.venueFeeBps + l.builderFeeBps + l.slippageBps + l.fundingCostBps) * 1e4) / 1e4);
  });
});
