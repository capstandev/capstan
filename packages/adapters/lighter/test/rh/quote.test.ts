// R2: RH quotes show collateralAsset USDG and are never converted to USDC; against a USDC venue the comparison carries
// the depeg flag when |USDG/USDC - 1| > 25 bps.
import { afterAll, describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";
import { createLighterAdapter, LIGHTER_CONFIGS, rhQuoteView } from "../../src";
import { fakeClock, fakeLighter } from "../helpers";

const rh = fakeLighter("lighter-466324");
afterAll(() => rh.stop());

describe("rh quote", () => {
  test("usdg-no-convert", async () => {
    const cache = memoryMarketDataCache();
    const a = createLighterAdapter(LIGHTER_CONFIGS.rh, { http: venueHttp("lighter-466324", rh.url, createMemoryGovernor("t", fakeClock().opts)), cache });
    await cache.putBook({ marketId: "lighter-rh:-:ETH", asks: [["2243.10", "1"], ["2243.50", "2"]], bids: [["2242.90", "3"]], asOf: new Date().toISOString() });
    const q = await a.quote({ marketId: "lighter-rh:-:ETH", side: "buy", sizeBase: "2", leverage: 2, holdHours: 0, orderType: "market" });
    expect(q.collateralAsset).toBe("USDG");
    expect(q.avgFillPx).toBe("2243.3"); // (2243.10 + 2243.50) / 2 on the venue prices, in USDG
    expect(q.builderFeeBps).toBe(0);
    expect(q.venueFeeBps).toBe(0); // Standard on RH (docs table)
    // compared with a USDC venue: no conversion, flags only
    const calm = rhQuoteView(q, { againstCollateral: "USDC", usdgPerUsdc: "0.9990" });
    expect(calm.avgFillPx).toBe(q.avgFillPx);
    expect(calm.flags).toEqual([]);
    expect(calm.depegBps).toBe(10);
    const off = rhQuoteView(q, { againstCollateral: "USDC", usdgPerUsdc: "0.9970" });
    expect(off.flags).toEqual(["DEPEG_FLAG"]);
    expect(off.avgFillPx).toBe(q.avgFillPx);
    expect(rhQuoteView(q, { againstCollateral: "USDC", usdgPerUsdc: "1.0026" }).flags).toEqual(["DEPEG_FLAG"]);
    expect(rhQuoteView(q, { againstCollateral: "USDC", usdgPerUsdc: "1.0025" }).flags).toEqual([]); // 25 bps is not over
    expect(rhQuoteView(q, { againstCollateral: "USDC", usdgPerUsdc: null }).flags).toEqual(["DEPEG_UNKNOWN"]);
    expect(rhQuoteView(q, { againstCollateral: "USDG", usdgPerUsdc: "0.9" }).flags).toEqual([]); // same collateral
  });
});
