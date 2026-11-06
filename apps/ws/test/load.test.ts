// R11 (todo 29, spec D1 green test): 5,000 local subscribers on book: and markets.ticker: channels receive the 1 s
// coalesced ticker with p99 delivery under 500 ms on this Mac; results in ops/load/last-run.json. Acceptance only:
// runs with WS_LOAD=1.
import { describe, expect, test } from "bun:test";
import { runWsLoad } from "../../../ops/load/ws-load";

const d = process.env.WS_LOAD === "1" ? test : test.skip;

describe("ws load", () => {
  d("5k-subscribers", async () => {
    const r = await runWsLoad(5000, 6);
    console.log(JSON.stringify(r));
    expect(r.connected).toBe(5000);
    expect(r.tickersReceived).toBeGreaterThanOrEqual(5000 * 4); // about one ticker a second for each subscriber
    expect(r.booksReceived).toBeGreaterThan(5000 * 10);
    expect(r.p99Ms).toBeLessThan(500);
  }, 120_000);
});
