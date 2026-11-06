import { describe, expect, test } from "bun:test";
import { marketId, type Market, type VenueId } from "@capstan/schema";
import { baseSymbol, CRYPTO_MAJORS, proposeCanonical } from "../src/propose";
import { asterSource, hyperliquidSource } from "./fixture-sources";

function mk(venue: VenueId, sym: string, o: Partial<Market> = {}): Market {
  return {
    id: marketId(venue, o.dex ?? null, sym), venue, dex: null, venueSymbol: sym, marketType: "perp", canonicalAsset: null, collateralAsset: "USDC",
    tickSize: "0.1", lotSize: "0.001", minNotional: null, maxLeverage: 20, marginModes: ["cross"], fundingIntervalS: 3600, fundingSettleIntervalS: 3600,
    sessionHours: null, oiCapUsd: null, builderFeeUnit: null, status: "active", executable: false, dataFreshness: "live", updatedAt: "t", ...o,
  };
}

describe("proposeCanonical", () => {
  test("majors-exact", () => {
    for (const [v, s] of [["hyperliquid", "BTC"], ["aster", "BTCUSDT"], ["variational", "BTC-PERP"], ["arcus", "BTC-USD"], ["lighter-mainnet", "BTC"], ["aster", "BTCUSD1"], ["aster", "BTCU"]] as [VenueId, string][]) {
      expect(proposeCanonical(mk(v, s)), `${v} ${s}`).toEqual({ asset: "CR:BTC", auto: true, reason: "crypto major BTC: exact symbol" });
    }
    for (const s of ["WBTC", "BTC2", "kBTC", "BTCB", "XBTC", "BTC.D", "UBTC"]) {
      const p = proposeCanonical(mk("hyperliquid", s));
      expect(p.auto, s).toBe(false);
      expect(p.asset, s).toBeNull();
    }
    expect(baseSymbol("ETHUSDT")).toBe("ETH");
    expect(baseSymbol("kPEPE")).toBe("kPEPE");
    expect(CRYPTO_MAJORS).toContain("ETH");
  });

  test("no-auto-equity", () => {
    // xyz:TSLA (HIP-3 deployer) and Aster TSLAUSDT (stock perp) both stay unmapped, even though symbols match
    const xyz = proposeCanonical(mk("hyperliquid", "xyz:TSLA", { dex: "xyz" }));
    expect(xyz.auto).toBe(false);
    const ast = proposeCanonical(mk("aster", "TSLAUSDT", { assetClassHint: "EQ" }));
    expect(ast.auto).toBe(false);
    for (const cls of ["EQ", "ETF", "IX", "RT", "CM", "PI"] as const) expect(proposeCanonical(mk("arcus", "SPY-USD", { assetClassHint: cls })).auto).toBe(false);
    // even a major symbol on a deployer dex waits for review
    expect(proposeCanonical(mk("hyperliquid", "xyz:BTC", { dex: "xyz" }))).toEqual({ asset: "CR:BTC", auto: false, reason: "deployer market on xyz: proposal for review" });
    // and over the whole recorded catalog, nothing but a crypto major is ever auto-mapped
    return Promise.all([hyperliquidSource().listMarkets(), asterSource().listMarkets()]).then(([hl, as]) => {
      for (const m of [...hl, ...as]) {
        const p = proposeCanonical(m);
        if (p.auto) expect(p.asset!.startsWith("CR:") && CRYPTO_MAJORS.includes(p.asset!.slice(3)), m.id).toBe(true);
      }
    });
  });

  test("aster-stock-proposal-only", async () => {
    const stocks = (await asterSource().listMarkets()).filter((m) => m.assetClassHint === "EQ");
    expect(stocks.length).toBeGreaterThan(0);
    for (const m of stocks) {
      const p = proposeCanonical(m);
      expect(p.auto).toBe(false);
      expect(p.asset).toBe(`EQ:${baseSymbol(m.venueSymbol)}` as never);
    }
    expect(proposeCanonical(mk("aster", "TSLAUSDT", { assetClassHint: "EQ" })).asset).toBe("EQ:TSLA");
  });

  test("non-perp markets are not mapped", () => {
    expect(proposeCanonical(mk("lighter-rh", "ETH", { marketType: "spot" }))).toEqual({ asset: null, auto: false, reason: "market type spot: not mapped" });
  });
});
