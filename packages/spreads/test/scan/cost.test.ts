// R4: round-trip cost counts open and close on both legs: venue fees, builder fees (HL 2, Aster 2, Lighter 0) and
// slippage at the requested size.
import { describe, expect, test } from "bun:test";
import { roundTripCostBps, scan } from "../../src";
import { M, REQ, setup } from "./helpers";

describe("cost", () => {
  test("round-trip", async () => {
    const q = (venueFeeBps: number, builderFeeBps: number, slippageBps: number) => ({ venueFeeBps, builderFeeBps, slippageBps });
    expect(roundTripCostBps(q(4.5, 2, 1.25), q(0, 0, 0.5), q(4.5, 2, 1.2), q(0, 0, 0.55))).toBe(16.5);
    expect(roundTripCostBps(q(0.1, 0, 0), q(0.2, 0, 0), q(0, 0, 0), q(0, 0, 0))).toBe(0.3); // exact, not 0.30000000000000004
    expect(() => roundTripCostBps(q(-1, 0, 0), q(0, 0, 0), q(0, 0, 0), q(0, 0, 0))).toThrow();

    // through the scanner: HL (4.5 venue + 2 builder) and Aster (3.5 + 2) on both open and close, plus each walk's slippage
    const s = setup({ markets: [M.hl, M.aster], eqs: [{ id: "e", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.aster.id], status: "approved", notes: "r\noverride: USDT leg reviewed" }] });
    const [r] = await scan(REQ, s.deps);
    const fees = 2 * (4.5 + 2) + 2 * (3.5 + 2);
    // 1 ETH fits the first level of every fixture book, so slippage (measured from the best price) is 0 here
    expect(r!.roundTripCostBps).toBe(fees);
    const [rBig] = await scan({ ...REQ, sizeUsd: "30000" }, s.deps);
    expect(rBig!.roundTripCostBps).toBeGreaterThan(fees); // 15 ETH walks several levels on each of the four quotes
    // Lighter charges no builder fee and no venue fee on the standard tier: an HL + Lighter pair costs 2 x 6.5 + slippage
    const l = setup({ markets: [M.hl, M.lt], eqs: [{ id: "e", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.lt.id], status: "approved", notes: "" }] });
    const [rl] = await scan(REQ, l.deps);
    expect(rl!.roundTripCostBps).toBe(13);
    expect(rl!.roundTripCostBps).toBeLessThan(r!.roundTripCostBps);
    // a bigger size walks deeper: more slippage, higher cost
    const [big] = await scan({ ...REQ, sizeUsd: "30000" }, l.deps);
    expect(big!.roundTripCostBps).toBeGreaterThan(rl!.roundTripCostBps);
  });
});
