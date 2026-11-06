// R12: estLiqPx is null (never a guess) for a venue whose margin model is not implemented.
import { describe, expect, test } from "bun:test";
import { estLiqPx } from "../src/liq";
import { genericMarket } from "./helpers";

describe("liq", () => {
  test("null-not-guess", () => {
    // not implemented: Aster, Variational, Arcus
    expect(estLiqPx("aster", genericMarket("aster:-:ETHUSDT", "aster"), "2000", 10, "buy")).toBeNull();
    expect(estLiqPx("variational", genericMarket("variational:-:ETH-PERP", "variational"), "2000", 10, "buy")).toBeNull();
    expect(estLiqPx("arcus", genericMarket("arcus:-:ETH-USD", "arcus", { maintenanceMarginFraction: "0.016667" }), "2000", 10, "buy")).toBeNull();
    // a market that carries a maintenance fraction is still null when its venue has no implemented model, so adding
    // a venue to LIQ_MODELS without its margin rules is caught here
    for (const [id, venue] of [["aster:-:ETHUSDT", "aster"], ["variational:-:ETH-PERP", "variational"]] as const) {
      const withMmf = genericMarket(id, venue, { maxLeverage: 50, maintenanceMarginFraction: "0.005" });
      for (const side of ["buy", "sell"] as const) expect(estLiqPx(venue, withMmf, "2000", 10, side)).toBeNull();
    }
    // Lighter without the maintenance fraction from meta: null; with it, the isolated formula
    const lt = genericMarket("lighter-mainnet:-:ETH", "lighter-mainnet", { maxLeverage: 50 });
    expect(estLiqPx("lighter-mainnet", lt, "2000", 10, "buy")).toBeNull();
    const lt2 = { ...lt, maintenanceMarginFraction: "0.006" };
    // long: 2000 x (1 - 0.1) / (1 - 0.006) = 1810.86519115
    expect(estLiqPx("lighter-mainnet", lt2, "2000", 10, "buy")).toBe("1810.86519115");
    // short: 2000 x 1.1 / 1.006 = 2186.87872763
    expect(estLiqPx("lighter-mainnet", lt2, "2000", 10, "sell")).toBe("2186.87872763");
    // Hyperliquid: maintenance = half the initial margin at max leverage (1 / (2 x 50) = 0.01)
    const hl = genericMarket("hyperliquid:-:ETH", "hyperliquid", { maxLeverage: 50 });
    expect(estLiqPx("hyperliquid", hl, "2000", 10, "buy")).toBe("1818.18181818");
    expect(estLiqPx("hyperliquid", hl, "2000", 10, "sell")).toBe("2178.21782178");
    // above the market maximum, at or under maintenance, or no max leverage known: null
    expect(estLiqPx("hyperliquid", hl, "2000", 51, "buy")).toBeNull();
    expect(estLiqPx("hyperliquid", { ...hl, maxLeverage: null }, "2000", 10, "buy")).toBeNull();
    expect(estLiqPx("lighter-mainnet", { ...lt2, maintenanceMarginFraction: "0.2" }, "2000", 10, "buy")).toBeNull();
    // long liq below entry, short liq above
    for (const lev of [1.5, 2, 3, 5, 10, 20, 40]) {
      expect(Number(estLiqPx("hyperliquid", hl, "2000", lev, "buy"))).toBeLessThan(2000);
      expect(Number(estLiqPx("hyperliquid", hl, "2000", lev, "sell"))).toBeGreaterThan(2000);
    }
  });
});
