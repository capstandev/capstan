// R6: a -10% shock on CR:ETH lists exactly the venues whose positions cross their own liq price; a long on one venue
// and a short on another can both appear (each venue is judged alone: an opposite position elsewhere never helps).
import { describe, expect, test } from "bun:test";
import { stress } from "../src";
import { pos, snap } from "./helpers";

const ETH = { canonicalAsset: "CR:ETH" as const };

describe("stress", () => {
  test("independent-venues", () => {
    const snaps = [
      // HL long, liq 1820 (9% under the 2000 mark): crosses at -10%
      snap("hyperliquid", [pos("hyperliquid", "hyperliquid:-:ETH", { ...ETH, liqPx: "1820" })]),
      // Lighter long, liq 1700 (15% under): survives -10%
      snap("lighter-mainnet", [pos("lighter-mainnet", "lighter-mainnet:-:ETH", { ...ETH, liqPx: "1700" })]),
      // Aster short, liq 2150 (7.5% over): crosses at +10%, safe at -10%
      snap("aster", [pos("aster", "aster:-:ETHUSDT", { ...ETH, side: "short", liqPx: "2150" })]),
      // another asset never shows up under ETH
      snap("lighter-rh", [pos("lighter-rh", "lighter-rh:-:HYPE", { canonicalAsset: "CR:HYPE", liqPx: "1999" })]),
    ];
    const rows = stress(snaps, [-10, -5, 10]);
    const at = (asset: string, shock: number) => rows.find((r) => r.canonicalAsset === asset && r.shockPct === shock)!.venuesLiquidated;
    expect(at("CR:ETH", -10)).toEqual(["hyperliquid"]);
    expect(at("CR:ETH", -5)).toEqual([]);
    expect(at("CR:ETH", 10)).toEqual(["aster"]);
    // the long and the short are on different venues and BOTH appear across the shocks: the short does not offset
    // the long's liquidation, because each venue liquidates independently
    expect([...at("CR:ETH", -10), ...at("CR:ETH", 10)].sort()).toEqual(["aster", "hyperliquid"]);
    expect(at("CR:HYPE", -5)).toEqual(["lighter-rh"]);
    // exactly at the liq price counts as crossing; null liq never crosses
    expect(stress([snap("hyperliquid", [pos("hyperliquid", "hyperliquid:-:ETH", { ...ETH, liqPx: "1800" })])], [-10])[0]!.venuesLiquidated).toEqual(["hyperliquid"]);
    expect(stress([snap("hyperliquid", [pos("hyperliquid", "hyperliquid:-:ETH", { ...ETH, liqPx: null })])], [-90])[0]!.venuesLiquidated).toEqual([]);
    // fresh marks are used when given
    expect(stress(snaps, [-10], new Map([["lighter-mainnet:-:ETH", "1880"]])).find((r) => r.canonicalAsset === "CR:ETH")!.venuesLiquidated).toEqual(["hyperliquid", "lighter-mainnet"]);
  });
});
