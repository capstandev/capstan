// R2 (RH 94 books: 67 perps, 27 spot; spot never executable) and R3 (mainnet 214 active perps, 21 inactive, 11 spot)
// from full recorded listings, plus the market mapping rules.
import { afterAll, describe, expect, test } from "bun:test";
import { LIGHTER_CONFIGS } from "../src";
import { fakeLighter, readerFor } from "./helpers";

const rh = fakeLighter("lighter-466324");
const main = fakeLighter("lighter-304");
afterAll(() => {
  rh.stop();
  main.stop();
});

describe("read", () => {
  test("rh-perp-filter", async () => {
    const ms = await readerFor(LIGHTER_CONFIGS.rh, rh.url).listMarkets();
    expect(ms.length).toBe(94);
    const perps = ms.filter((m) => m.marketType === "perp");
    const spot = ms.filter((m) => m.marketType === "spot");
    expect(perps.length).toBe(67);
    expect(spot.length).toBe(27);
    for (const m of ms) {
      expect(m.venue).toBe("lighter-rh");
      expect(m.executable).toBe(false);
      expect(m.collateralAsset).toBe("USDG");
      expect(m.id.startsWith("lighter-rh:-:")).toBe(true);
    }
    for (const m of spot) {
      expect(m.maxLeverage).toBeNull();
      expect(m.marginModes).toEqual([]);
    }
    // AMZN on RH: default IMF 666 (6.66%) -> 15x
    const amzn = perps.find((m) => m.venueSymbol === "AMZN");
    expect(amzn?.maxLeverage).toBe(15);
  });

  test("mainnet-counts", async () => {
    const ms = await readerFor(LIGHTER_CONFIGS.mainnet, main.url).listMarkets();
    expect(ms.length).toBe(246);
    const perps = ms.filter((m) => m.marketType === "perp");
    expect(perps.filter((m) => m.status !== "delisted").length).toBe(214);
    expect(perps.filter((m) => m.status === "delisted").length).toBe(21);
    expect(ms.filter((m) => m.marketType === "spot").length).toBe(11);
    expect(new Set(ms.map((m) => m.id)).size).toBe(246);
    const eth = ms.find((m) => m.venueSymbol === "ETH")!;
    expect(eth).toMatchObject({ id: "lighter-mainnet:-:ETH", venueIndex: 0, marketType: "perp", fundingIntervalS: 3600, fundingSettleIntervalS: 3600, builderFeeUnit: "ppm", collateralAsset: "USDC", sessionHours: null, dex: null });
    expect(eth.marginModes).toEqual(["cross", "isolated"]);
    // isolated-only markets (market_margin_mode 1), e.g. H100
    expect(ms.find((m) => m.venueSymbol === "H100")?.marginModes).toEqual(["isolated"]);
    // force_reduce_only active markets are reduce_only, never active
    expect(perps.some((m) => m.status === "reduce_only")).toBe(true);
    for (const m of ms) {
      expect(Number(m.tickSize)).toBeGreaterThan(0);
      expect(Number(m.lotSize)).toBeGreaterThan(0);
    }
  });
});
