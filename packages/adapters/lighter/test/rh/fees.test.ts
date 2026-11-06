// R9: RH tier fees used in quotes come from the docs table with tierSource 'docs'.
import { afterAll, describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";
import { createLighterAdapter, LIGHTER_CONFIGS, LIGHTER_FEES } from "../../src";
import { fakeClock, fakeLighter } from "../helpers";

const rh = fakeLighter("lighter-466324");
afterAll(() => rh.stop());

describe("rh fees", () => {
  test("docs-tiers", async () => {
    const a = createLighterAdapter(LIGHTER_CONFIGS.rh, { http: venueHttp("lighter-466324", rh.url, createMemoryGovernor("t", fakeClock().opts)), cache: memoryMarketDataCache() });
    const s = await a.reader.feeSchedule();
    expect(s.tierSource).toBe("docs");
    expect(s.tiers).toEqual({ standard: { ...LIGHTER_FEES["lighter-rh"].standard }, plus: { ...LIGHTER_FEES["lighter-rh"].plus }, premium: { ...LIGHTER_FEES["lighter-rh"].premium } });
    const cache = memoryMarketDataCache();
    const b = createLighterAdapter(LIGHTER_CONFIGS.rh, { http: venueHttp("lighter-466324", rh.url, createMemoryGovernor("t", fakeClock().opts)), cache });
    await cache.putBook({ marketId: "lighter-rh:-:ETH", asks: [["2243.10", "5"]], bids: [["2242.90", "5"]], asOf: new Date().toISOString() });
    const base = { marketId: "lighter-rh:-:ETH", side: "buy" as const, sizeBase: "1", leverage: 1, holdHours: 0 };
    expect((await b.quote({ ...base, orderType: "market", feeTier: "plus" })).venueFeeBps).toBe(1.5);
    expect((await b.quote({ ...base, orderType: "market", feeTier: "premium" })).venueFeeBps).toBe(3.5);
    expect((await b.quote({ ...base, orderType: "limit", limitPx: "2243.10", feeTier: "premium" })).venueFeeBps).toBe(1.2);
    expect((await b.quote({ ...base, orderType: "market" })).venueFeeBps).toBe(0); // Standard when the tier is unknown
  });
});
