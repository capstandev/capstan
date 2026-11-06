// Live read-only checks against the venues' public info endpoints. Skipped unless CAPSTAN_LIVE=1 (public CI never
// depends on a venue being up). Each one confirms the recorded fixture still has the fields adapters read.
import { describe, expect, test } from "bun:test";
import { VENUE_HOSTS } from "@capstan/schema";
import { FIXTURE_SPECS, missingFields } from "../src/fixtures";
import { createMemoryGovernor } from "../src/governor";
import { venueHttp } from "../src/http";

const live = process.env.CAPSTAN_LIVE === "1" ? describe : describe.skip;
const gov = createMemoryGovernor("live-test");

live("live venue reads (CAPSTAN_LIVE=1)", () => {
  test("hyperliquid meta keeps the recorded fields", async () => {
    const r = await venueHttp("hyperliquid", VENUE_HOSTS.hyperliquid.rest, gov).postJson("/info", { type: "meta" });
    expect(missingFields(r, FIXTURE_SPECS["hyperliquid/meta"]!)).toEqual([]);
  });
  test("lighter order books on both configs", async () => {
    for (const [key, host] of [["lighter-304", VENUE_HOSTS.lighterMainnet.rest], ["lighter-466324", VENUE_HOSTS.lighterRh.rest]] as const) {
      const r = await venueHttp(key, host, gov).getJson("/api/v1/orderBooks");
      expect(missingFields(r, FIXTURE_SPECS[`${key}/orderBooks`]!)).toEqual([]);
    }
  });
  test("aster premium index", async () => {
    const r = await venueHttp("aster", VENUE_HOSTS.aster.rest, gov).getJson("/fapi/v3/premiumIndex", { symbol: "BTCUSDT" });
    expect(missingFields(r, FIXTURE_SPECS["aster/premiumIndex_BTCUSDT"]!)).toEqual([]);
  });
  test("arcus bbo", async () => {
    const r = await venueHttp("arcus", VENUE_HOSTS.arcus.rest, gov).getJson("/v1/bbo/BTC-USD");
    expect(missingFields(r, FIXTURE_SPECS["arcus/bbo_BTC-USD"]!)).toEqual([]);
  });
});
