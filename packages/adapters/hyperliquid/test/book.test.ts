// R12: book levels stay strings; asOf is the venue's time even when old.
import { describe, expect, test } from "bun:test";
import { fixtureReader, fx } from "./helpers";

describe("book", () => {
  test("as-of", async () => {
    const { reader } = fixtureReader(); // the clock is ahead of the fixture time
    const raw = fx("l2Book_BTC");
    const b = await reader.getBook("hyperliquid:-:BTC");
    expect(b.asOf).toBe(new Date(raw.time).toISOString());
    expect(Date.parse(b.asOf)).toBeLessThan(1793934060000 - 3000); // older than 3 s, still returned with its real asOf
    expect(b.bids[0]).toEqual([raw.levels[0][0].px, raw.levels[0][0].sz]);
    expect(b.asks[0]).toEqual([raw.levels[1][0].px, raw.levels[1][0].sz]);
    for (const [px, sz] of [...b.bids, ...b.asks]) {
      expect(typeof px).toBe("string");
      expect(typeof sz).toBe("string");
    }
    expect(b.bids[0]![0]).toBe("76154.0"); // trailing zero kept exactly as published
    const d5 = await reader.getBook("hyperliquid:xyz:TSLA", 5);
    expect(d5.bids.length).toBe(5);
    expect(d5.asks.length).toBe(5);
    expect(d5.marketId).toBe("hyperliquid:xyz:TSLA");
  });
});
