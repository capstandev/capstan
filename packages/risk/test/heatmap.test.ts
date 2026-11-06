// R12: the heatmap output contains no address or account index, only price buckets and notional per venue.
import { describe, expect, test } from "bun:test";
import { liqHeatmap, samplesFromViews, type PublicPositionSample } from "../src";

describe("heatmap", () => {
  test("no-identifiers", () => {
    const smuggled = [
      { venue: "hyperliquid", marketId: "hyperliquid:-:ETH", liqPx: "1800", markPx: "2000", notionalUsd: "1000", owner: "0x2ac6e76aeb3102d322ee9a82bd67d447d8781014", accountIndex: 4242 },
      { venue: "hyperliquid", marketId: "hyperliquid:-:ETH", liqPx: "1805", markPx: "2000", notionalUsd: "500", agentRef: "hl:0xabc" },
      { venue: "lighter-mainnet", marketId: "lighter-mainnet:-:ETH", liqPx: "2210", markPx: "2001", notionalUsd: "300.5", identity: { accountIndex: 99, owner: "0x00000000000000000000000000000000000A11CE" } },
      { venue: "aster", marketId: "aster:-:ETHUSDT", liqPx: "1900", markPx: "2000", notionalUsd: "999" }, // not a public account source
      { venue: "hyperliquid", marketId: "hyperliquid:-:ETH", liqPx: null, markPx: "2000", notionalUsd: "77" },
    ] as unknown as PublicPositionSample[];
    const h = liqHeatmap("CR:ETH", smuggled, 0.5);
    const out = JSON.stringify(h);
    expect(out).not.toMatch(/0x[0-9a-fA-F]{6,}/);
    expect(out).not.toMatch(/4242|"99"|accountIndex|owner|agentRef|identity/);
    expect(Object.keys(h).sort()).toEqual(["bucketPct", "canonicalAsset", "notionalByVenue", "priceBuckets", "referencePx", "samples"]);
    expect(Object.keys(h.notionalByVenue)).toEqual(["hyperliquid", "lighter-mainnet"]); // Aster excluded
    expect(h.samples).toBe(3);
    expect(h.referencePx).toBe("2000");
    // 1800 and 1805 sit in the -10% bucket (index -20), 2210 in +10.5% (index 21)
    expect(h.priceBuckets[0]).toBe("1800");
    expect(h.priceBuckets.length).toBe(42);
    expect(h.notionalByVenue.hyperliquid![0]).toBe("1500.00");
    expect(h.notionalByVenue["lighter-mainnet"]![41]).toBe("300.50");
    expect(h.notionalByVenue.hyperliquid!.slice(1).every((x) => x === "0.00")).toBe(true);
    // samples from stored views carry numbers only
    const s = samplesFromViews([{ perVenue: [{ venue: "hyperliquid", identity: { owner: "0x2ac6e76aeb3102d322ee9a82bd67d447d8781014" }, positions: [{ venue: "hyperliquid", marketId: "hyperliquid:-:ETH", canonicalAsset: "CR:ETH", liqPx: "1", markPx: "2", notionalUsd: "3", size: "9" }] }] } as never], "CR:ETH");
    expect(s).toEqual([{ venue: "hyperliquid", marketId: "hyperliquid:-:ETH", liqPx: "1", markPx: "2", notionalUsd: "3" }]);
    expect(liqHeatmap("CR:ETH", []).priceBuckets).toEqual([]);
  });
});
