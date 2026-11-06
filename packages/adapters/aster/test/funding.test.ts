// Funding rules R2 and R3 (todo 13): the interval is re-read every tick and never trusted past one hour.
import { memoryMarketDataCache } from "@capstan/core";
import { Dec } from "@capstan/schema";
import { describe, expect, test } from "bun:test";
import { createAsterIngest } from "../src/ingest";
import { normalizeFunding } from "../src/normalize";
import { FUNDING_INFO_MAX_AGE_MS, FUNDING_INFO_MIN_GAP_MS } from "../src/read";
import { defaultRoutes, fundingInfo, harness, json, premiumIndexAll } from "./helpers";
import { fakeWs } from "./ws-helpers";

const SCALE = 18;
const d = (s: string) => Dec.parse(s, SCALE, "half_even");

describe("aster funding", () => {
  test("interval-change-one-tick", async () => {
    // fixture A: PTBUSDT at 8 h; fixture B (after the venue changed it): 1 h
    const rowsA = fundingInfo().map((r) => (r.symbol === "PTBUSDT" ? { ...r, fundingIntervalHours: 8 } : r));
    const rowsB = fundingInfo().map((r) => (r.symbol === "PTBUSDT" ? { ...r, fundingIntervalHours: 1 } : r));
    let phase: "A" | "B" = "A";
    let fundingInfoHits = 0;
    let clock = 1_793_933_000_000;
    const h = harness(
      defaultRoutes({
        "GET /fapi/v3/fundingInfo": () => {
          fundingInfoHits++;
          return json(phase === "A" ? rowsA : rowsB);
        },
      }),
      { now: () => clock, ws: () => fakeWs().ws },
    );
    const cache = memoryMarketDataCache();
    const ingest = createAsterIngest({ reader: h.reader, cache, routedSymbols: async () => [], now: () => clock });
    try {
      const pi = premiumIndexAll().find((r) => r.symbol === "PTBUSDT")!;
      await ingest.tick();
      const a = await h.reader.getFunding("aster:-:PTBUSDT");
      expect(a.intervalS).toBe(8 * 3600);
      expect(a.ratePerHour).toBe(Dec.toString(Dec.div(d(pi.lastFundingRate), d("8"), SCALE)));
      // the venue changes the interval; one 60 s job tick later the snapshot uses it
      phase = "B";
      clock += FUNDING_INFO_MIN_GAP_MS;
      const rep = await ingest.tick();
      expect(rep.intervalChanges).toEqual([{ symbol: "PTBUSDT", fromS: 28800, toS: 3600 }]);
      const b = await h.reader.getFunding("aster:-:PTBUSDT");
      expect(b.intervalS).toBe(3600);
      expect(b.ratePerHour).toBe(Dec.toString(d(pi.lastFundingRate)));
      // the cached snapshot for the changed market was rewritten in the same tick
      expect((await cache.getFunding("aster:-:PTBUSDT"))!.intervalS).toBe(3600);
      expect(fundingInfoHits).toBe(2);
      // without ticks, the table is still never used past one hour
      phase = "A";
      clock += FUNDING_INFO_MAX_AGE_MS - 1;
      expect((await h.reader.getFunding("aster:-:PTBUSDT")).intervalS).toBe(3600); // under 1 h: cached
      expect(fundingInfoHits).toBe(2);
      clock += 2;
      expect((await h.reader.getFunding("aster:-:PTBUSDT")).intervalS).toBe(28800); // over 1 h: re-read
      expect(fundingInfoHits).toBe(3);
      expect(h.reader.intervalsAgeMs()).toBe(0);
    } finally {
      ingest.stop();
      h.stop();
    }
  });

  test("normalise-all-cadences", async () => {
    const rate = "0.00010000";
    for (const hours of [1, 2, 4, 8]) {
      const f = normalizeFunding({ symbol: "XUSDT", lastFundingRate: rate, nextFundingTime: 1793952000000, time: 1793933258000 }, { hours, cap: "0.02", floor: "-0.02" });
      const perHour = Dec.div(d(rate), d(String(hours)), SCALE);
      expect(f.intervalS).toBe(hours * 3600);
      expect(f.ratePerInterval).toBe("0.0001");
      expect(f.ratePerHour).toBe(Dec.toString(perHour));
      expect(f.rateAnnualised).toBe(Dec.toString(Dec.mul(perHour, d("8760"), SCALE)));
      expect(f.capPerHour).toBe(Dec.toString(Dec.div(d("0.02"), d(String(hours)), SCALE)));
      expect(f.nextSettlementAt).toBe(new Date(1793952000000).toISOString()); // ms, not s
      expect(f.source).toBe("venue");
      expect(f.marketId).toBe("aster:-:XUSDT");
    }
    // the recorded table covers every cadence, and every live snapshot normalises the same way
    const h = harness();
    try {
      const map = await h.reader.fundingIntervals();
      const cadences = new Set(Object.values(map).map((v) => v.hours));
      for (const c of [1, 2, 4, 8]) expect(cadences.has(c)).toBe(true);
      expect(Object.values(map).every((v) => !/e/i.test(v.cap) && !/e/i.test(v.floor))).toBe(true);
      const all = await h.reader.allFunding();
      expect(all.length).toBeGreaterThan(590);
      for (const f of all) {
        const iv = map[f.marketId.slice("aster:-:".length)]!;
        expect(f.intervalS).toBe(iv.hours * 3600);
        expect(Dec.cmp(Dec.mul(d(f.ratePerHour), d(String(iv.hours)), SCALE), d(f.ratePerInterval))).toBe(0);
        expect(Dec.cmp(d(f.rateAnnualised), Dec.mul(d(f.ratePerHour), d("8760"), SCALE))).toBe(0);
      }
    } finally {
      h.stop();
    }
  });
});
