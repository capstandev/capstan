// R1: 20 recorded live books per venue (HL core, HL xyz, Lighter 304, Lighter-RH, Aster) give exactly the committed
// avgFillPx, slippageBps and totalCostBps. The expected file comes from scripts/golden-expected.py, an independent
// implementation in Python's decimal module, so this test is not the engine checking itself.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Dec } from "@capstan/schema";
import { routeQuote } from "../src/route";
import { BOOK_SETS, deps, funding, marketFor, recorded, staticCache } from "./helpers";

type Expected = { marketId: string; side: "buy" | "sell"; status: string; sizeBase?: string; limitPx?: string; avgFillPx?: string; slippageBps?: number; venueFeeBps?: number; builderFeeBps?: number; fundingCostBps?: number; totalCostBps?: number };
const EXPECTED = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures/golden-expected.json"), "utf8")) as { scenarios: Record<string, Expected[]> }).scenarios;

describe("golden", () => {
  test("recorded-books", async () => {
    let checked = 0;
    let ok = 0;
    for (const set of BOOK_SETS) {
      const books = recorded(set);
      expect(books.length).toBe(20);
      expect(EXPECTED[set]!.length).toBe(20);
      for (let i = 0; i < books.length; i++) {
        const r = books[i]!;
        const e = EXPECTED[set]![i]!;
        const m = marketFor(set, r);
        const cache = staticCache();
        const now = Date.parse(r.book.asOf) + 500;
        await cache.putBook({ marketId: m.id, ...r.book });
        await cache.putFunding(funding(m.id, "0.0000125", new Date(now - 1000).toISOString()));
        const levels = e.side === "buy" ? r.book.asks : r.book.bids;
        // size: the first three levels, summed as exact decimals
        const sizeBase = levels.length ? levels.slice(0, 3).map(([, sz]) => sz).reduce(addDec) : "1";
        const req = { marketIds: [m.id], side: e.side, sizeBase, leverage: 1, holdHours: 8, orderType: "market" as const };
        const q = await routeQuote(req, deps({ markets: [m], cache, now: () => now }));
        const leg = q.legs[0]!;
        expect({ id: leg.marketId, status: leg.status as string }).toEqual({ id: e.marketId, status: e.status });
        if (e.status === "ok") {
          expect({ sizeBase: leg.sizeBase, limitPx: leg.limitPx, avgFillPx: leg.avgFillPx, slippageBps: leg.slippageBps, venueFeeBps: leg.venueFeeBps, builderFeeBps: leg.builderFeeBps, fundingCostBps: leg.fundingCostBps, totalCostBps: leg.totalCostBps }).toEqual({
            sizeBase: e.sizeBase!,
            limitPx: e.limitPx!,
            avgFillPx: e.avgFillPx!,
            slippageBps: e.slippageBps!,
            venueFeeBps: e.venueFeeBps!,
            builderFeeBps: e.builderFeeBps!,
            fundingCostBps: e.fundingCostBps!,
            totalCostBps: e.totalCostBps!,
          });
          expect(q.best).toBe(m.id);
          ok++;
        } else if (e.limitPx) {
          expect({ sizeBase: leg.sizeBase, limitPx: leg.limitPx }).toEqual({ sizeBase: e.sizeBase!, limitPx: e.limitPx });
          expect(q.best).toBeNull();
        }
        checked++;
      }
    }
    expect(checked).toBe(100);
    expect(ok).toBeGreaterThanOrEqual(90);
  });
});

function addDec(a: string, b: string): string {
  return Dec.toString(Dec.add(Dec.parse(a, 18), Dec.parse(b, 18)));
}
