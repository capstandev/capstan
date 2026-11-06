// R4: exposure is notional only (gross and net per canonical asset); unmapped positions are never grouped.
import { describe, expect, test } from "bun:test";
import { exposureByAsset, unmappedExposure } from "../src";
import { pos, snap } from "./helpers";

describe("exposure", () => {
  test("notional-only", () => {
    const snaps = [
      snap("hyperliquid", [pos("hyperliquid", "hyperliquid:-:ETH", { canonicalAsset: "CR:ETH", side: "long", notionalUsd: "3000.50" })], { equityUsd: "999999", freeCollateralUsd: "888888" }),
      snap("lighter-mainnet", [pos("lighter-mainnet", "lighter-mainnet:-:ETH", { canonicalAsset: "CR:ETH", side: "short", notionalUsd: "1000.25" })], { equityUsd: "777777" }),
      snap("aster", [pos("aster", "aster:-:FOOUSDT", { canonicalAsset: null, notionalUsd: "50" }), pos("aster", "aster:-:BARUSDT", { canonicalAsset: null, side: "short", notionalUsd: "70" })]),
    ];
    const ex = exposureByAsset(snaps);
    expect(ex).toEqual([{ canonicalAsset: "CR:ETH", grossUsd: "4000.75", netUsd: "2000.25", legs: ["hyperliquid:-:ETH", "lighter-mainnet:-:ETH"] }]);
    // nothing from equity or free collateral leaks into exposure
    expect(JSON.stringify(ex)).not.toMatch(/999999|888888|777777/);
    for (const row of ex) expect(Object.keys(row).sort()).toEqual(["canonicalAsset", "grossUsd", "legs", "netUsd"]);
    // unmapped positions are listed one by one, never summed with each other or with a mapped asset
    expect(unmappedExposure(snaps)).toEqual([
      { marketId: "aster:-:FOOUSDT", venue: "aster", side: "long", notionalUsd: "50" },
      { marketId: "aster:-:BARUSDT", venue: "aster", side: "short", notionalUsd: "70" },
    ]);
    // a short reported with a negative notional still counts by size and side
    expect(exposureByAsset([snap("hyperliquid", [pos("hyperliquid", "hyperliquid:-:ETH", { canonicalAsset: "CR:ETH", side: "short", notionalUsd: "-10" })])])[0]).toMatchObject({ grossUsd: "10", netUsd: "-10" });
  });
});
