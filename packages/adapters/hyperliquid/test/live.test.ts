// Three keyless live reads of the public info endpoint (reads only). Skipped unless HL_LIVE=1.
import { describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";
import { createHlReader, HL_MAINNET } from "../src";

const live = process.env.HL_LIVE === "1" ? test : test.skip;
const reader = () => createHlReader({ ...HL_MAINNET, builderAddress: null }, venueHttp("hyperliquid", "https://api.hyperliquid.xyz", createMemoryGovernor("live-test")), memoryMarketDataCache());

describe("live", () => {
  live("perpDexs-core-first", async () => {
    const d = await reader().perpDexs();
    expect(d[0]!.name).toBeNull();
    expect(d.find((x) => x.name === "xyz")!.index).toBe(1);
  }, 30_000);
  live("btc-book", async () => {
    const b = await reader().getBook("hyperliquid:-:BTC", 5);
    expect(b.bids.length).toBe(5);
    expect(Date.now() - Date.parse(b.asOf)).toBeLessThan(60_000);
  }, 30_000);
  live("xyz-funding", async () => {
    const f = await reader().getFunding("hyperliquid:xyz:TSLA");
    expect(f.intervalS).toBe(3600);
    expect(f.source).toBe("venue");
  }, 30_000);
});
