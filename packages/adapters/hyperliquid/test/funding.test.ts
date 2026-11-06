// R5, R6: funding per hour from the right source, caps.
import { describe, expect, test } from "bun:test";
import { normalizeFunding } from "../src";
import { fixtureReader, fx } from "./helpers";

describe("funding", () => {
  test("core-and-hip3", async () => {
    const { reader, http, cache } = fixtureReader();
    const btc = await reader.getFunding("hyperliquid:-:BTC");
    const pf = fx<[string, [string, { fundingRate: string; nextFundingTime: number }][]][]>("predictedFundings");
    const row = pf.find((r) => r[0] === "BTC")![1].find((v) => v[0] === "HlPerp")![1];
    expect(btc.ratePerHour).toBe(row.fundingRate);
    expect(btc.intervalS).toBe(3600);
    expect(btc.rateAnnualised).toBe(normalizeFunding(row.fundingRate).rateAnnualised);
    expect(Number(btc.rateAnnualised)).toBeCloseTo(Number(row.fundingRate) * 8760, 12);
    expect(btc.source).toBe("venue");
    expect(btc.nextSettlementAt).toBe(new Date(row.nextFundingTime).toISOString());
    expect(http.calls.some((c) => c.body.type === "predictedFundings")).toBe(true);
    expect(http.calls.some((c) => c.body.type === "metaAndAssetCtxs")).toBe(false);

    const tsla = await reader.getFunding("hyperliquid:xyz:TSLA");
    const [meta, ctxs] = fx("metaAndAssetCtxs_xyz");
    const i = meta.universe.findIndex((u: { name: string }) => u.name === "xyz:TSLA");
    expect(tsla.ratePerHour).toBe(ctxs[i].funding);
    expect(tsla.intervalS).toBe(3600);
    expect(tsla.source).toBe("venue");
    expect(http.calls.some((c) => c.body.type === "metaAndAssetCtxs" && c.body.dex === "xyz")).toBe(true);
    expect(await cache.getFunding("hyperliquid:xyz:TSLA")).toEqual(tsla);
    expect(normalizeFunding("0.0000125")).toEqual({ ratePerInterval: "0.0000125", intervalS: 3600, ratePerHour: "0.0000125", rateAnnualised: "0.1095" });
    expect(normalizeFunding("-0.0001").rateAnnualised).toBe("-0.876");
  });

  test("caps", async () => {
    const { reader } = fixtureReader();
    expect((await reader.getFunding("hyperliquid:-:BTC")).capPerHour).toBe("0.04");
    expect((await reader.getFunding("hyperliquid:para:10Y")).capPerHour).toBe("0.005"); // assetToFundingClamp
    expect((await reader.getFunding("hyperliquid:xyz:TSLA")).capPerHour).toBeNull();
  });
});
