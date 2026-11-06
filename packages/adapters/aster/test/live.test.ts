// Live read-only checks against the real venue (public unsigned GETs only). Skipped unless CAPSTAN_LIVE=1.
import { createMemoryGovernor } from "@capstan/venue-client";
import { describe, expect, test } from "bun:test";
import { ASTER_MAINNET } from "../src/config";
import { asterHttp, createAsterReader } from "../src/read";

const live = process.env.CAPSTAN_LIVE === "1" ? test : test.skip;

describe("aster live (read-only)", () => {
  live(
    "markets-funding-book",
    async () => {
      const r = createAsterReader(ASTER_MAINNET, asterHttp(ASTER_MAINNET, createMemoryGovernor("live")), null);
      const ms = await r.listMarkets();
      expect(ms.length).toBeGreaterThan(500);
      expect(ms.filter((m) => m.isEquity).length).toBeGreaterThan(100);
      const f = await r.getFunding("aster:-:BTCUSDT");
      expect([1, 2, 4, 8].map((h) => h * 3600)).toContain(f.intervalS);
      const b = await r.getBook("aster:-:BTCUSDT", 5);
      expect(b.bids.length).toBe(5);
    },
    30_000,
  );
});
