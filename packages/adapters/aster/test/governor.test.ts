// Weight accounting R6 (todo 13): costs passed to the governor match the measured weights.
import { describe, expect, test } from "bun:test";
import { depthLimitFor } from "../src/read";
import { harness } from "./helpers";

describe("aster governor", () => {
  test("weights", async () => {
    const h = harness();
    const cost = () => h.gov.costs.at(-1)!.cost;
    try {
      await h.reader.fundingIntervals();
      expect(cost()).toBe(10); // fundingInfo measured 10 (docs say 1)
      await h.reader.allFunding();
      expect(cost()).toBe(10); // premiumIndex with no symbol
      await h.reader.getFunding("aster:-:BTCUSDT");
      expect(cost()).toBe(1); // premiumIndex with a symbol
      await h.reader.listMarkets();
      expect(cost()).toBe(1);
      const depth: [number, number][] = [[5, 2], [10, 2], [20, 2], [50, 2], [100, 5], [500, 10], [1000, 20]];
      for (const [limit, w] of depth) {
        await h.reader.getBook("aster:-:BTCUSDT", limit);
        expect(cost()).toBe(w);
        expect(h.gov.costs.at(-1)!.venue).toBe("aster");
      }
      expect(depthLimitFor(7)).toBe(10);
      expect(depthLimitFor(5000)).toBe(1000);
      expect(depthLimitFor(undefined)).toBe(20);
      // fundingInfo at most once per minute, however often it is asked for (concurrent calls share one request)
      const before = h.server.hits.filter((x) => x.endsWith("/fundingInfo")).length;
      await Promise.all([h.reader.fundingIntervals(), h.reader.fundingIntervals(), h.reader.getFunding("aster:-:ETHUSDT"), h.reader.listMarkets()]);
      for (let i = 0; i < 5; i++) await h.reader.fundingIntervals();
      expect(h.server.hits.filter((x) => x.endsWith("/fundingInfo")).length).toBe(before);
    } finally {
      h.stop();
    }
  });

  test("weights-first-call-concurrent", async () => {
    let clock = 0;
    const h = harness(undefined, { now: () => clock });
    try {
      await Promise.all(Array.from({ length: 6 }, () => h.reader.fundingIntervals()));
      expect(h.server.hits.filter((x) => x.endsWith("/fundingInfo")).length).toBe(1);
      clock += 59_999;
      await h.reader.fundingIntervals();
      expect(h.server.hits.filter((x) => x.endsWith("/fundingInfo")).length).toBe(1);
      clock += 1;
      await h.reader.fundingIntervals();
      expect(h.server.hits.filter((x) => x.endsWith("/fundingInfo")).length).toBe(2);
    } finally {
      h.stop();
    }
  });
});
