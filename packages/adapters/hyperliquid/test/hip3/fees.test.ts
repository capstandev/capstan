// R4, R5: HIP-3 fees per market from the venue formula; the builder fee is added on top.
import { describe, expect, test } from "bun:test";
import { buildOrder, HL_BASE_FEES, hip3TakerFeeBps } from "../../src";
import { fx } from "../helpers";
import { setup } from "../orders/util";
import { ctx, hip3Setup, intent } from "./util";

describe("fees", () => {
  test("per-market", async () => {
    const { reader } = setup();
    const ms = await reader.listMarkets();
    const by = (s: string) => ms.find((m) => m.venueSymbol === s)!;
    const tsla = by("xyz:TSLA");
    expect(tsla.growthMode).toBe(true);
    const g = hip3TakerFeeBps(tsla, HL_BASE_FEES);
    expect(g).toBeGreaterThanOrEqual(0.45);
    expect(g).toBeLessThanOrEqual(0.9);
    expect(g).toBe(0.9);
    expect(hip3TakerFeeBps({ ...tsla, deployerFeeScale: "0" }, HL_BASE_FEES)).toBe(0.45);
    expect(hip3TakerFeeBps({ ...tsla, deployerFeeScale: "0.5" }, HL_BASE_FEES)).toBe(0.675);
    // every growth-mode market on the wired dexes sits in the band
    for (const m of ms.filter((x) => x.growthMode && x.dex && ["xyz", "io", "para"].includes(x.dex))) {
      const v = hip3TakerFeeBps(m, HL_BASE_FEES);
      expect(v).toBeGreaterThanOrEqual(0.45);
      expect(v).toBeLessThanOrEqual(0.9);
    }
    // xyz:GOLD (no growth mode): the 9 bps exchange fee the recorded fill paid
    const gold = by("xyz:GOLD");
    expect(gold.growthMode).toBe(false);
    expect(hip3TakerFeeBps(gold, HL_BASE_FEES)).toBe(9);
    for (const f of fx<any[]>("userFills_xyzGOLD")) {
      const ntl = Number(f.px) * Number(f.sz);
      const paid = ((Number(f.fee) - Number(f.builderFee ?? 0)) / ntl) * 1e4;
      expect(Math.abs(paid - 9)).toBeLessThanOrEqual((0.000001 / ntl) * 1e4 + 1e-9); // fee rounded to 6 decimals
    }
    // userA's growth-mode fill on xyz:XYZ100 with a 4% referral discount: 0.9 x 0.96
    const fill = fx<any[]>("userFillsByTime_userA").find((f) => f.coin === "xyz:XYZ100" && f.crossed)!;
    const ntl = Number(fill.px) * Number(fill.sz);
    expect(Math.abs((Number(fill.fee) / ntl) * 1e4 - hip3TakerFeeBps(by("xyz:XYZ100"), HL_BASE_FEES, "0.04"))).toBeLessThanOrEqual((0.000001 / ntl) * 1e4 + 1e-9);
    // the core schedule is never used for HIP-3, and the HIP-3 formula refuses a core market
    expect(() => hip3TakerFeeBps(by("BTC"), HL_BASE_FEES)).toThrow();
    const h = hip3Setup();
    const b = await buildOrder(intent(), ctx(), h.deps);
    expect(b.preview.venueFeeBps).toBe(0.864); // userA: base taker, 4% referral, growth mode
    expect(b.preview.venueFeeBps).not.toBe(4.5);
  });

  test("builder-on-top", async () => {
    const h = hip3Setup();
    const b = await buildOrder(intent(), ctx(), h.deps);
    const p = b.preview;
    expect(p.builderFeeBps).toBe(2); // not cut by the deployer share
    expect(p.totalCostBps).toBeCloseTo(p.venueFeeBps + p.builderFeeBps + p.slippageBps + p.fundingCostBps, 4);
    const gold = await buildOrder(intent({ marketId: "hyperliquid:xyz:GOLD", size: "0.01" }), ctx(), h.deps);
    expect(gold.preview.builderFeeBps).toBe(2);
    expect(gold.preview.venueFeeBps).toBe(8.64);
    expect(gold.preview.totalCostBps).toBeCloseTo(8.64 + 2 + gold.preview.slippageBps + gold.preview.fundingCostBps, 4);
  });
});
