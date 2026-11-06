// R10 (QUOTE-1): for 50 recorded books the preview equals the built order walked against the same book at the built
// limit, and the built limit never allows worse than maxSlippageBps.
import { describe, expect, test } from "bun:test";
import { buildOrder, fx, midOf } from "../../src";
import { fx as fixture } from "../helpers";
import { ctx, setup } from "./util";

const SC = 12;
const big = (x: string) => {
  const [i, f = ""] = x.split(".");
  return BigInt(i! + (f + "0".repeat(SC)).slice(0, SC));
};

/** Independent walk in exact integers (scale 1e12), no shared code with the adapter. */
function walk(levels: [string, string][], side: "buy" | "sell", size: string, limit: string): { avg: number; filled: number; cost: bigint; filledB: bigint } {
  let left = big(size);
  let cost = 0n; // scale 1e24
  let filled = 0n;
  const lim = big(limit);
  for (const [p, s] of levels) {
    const px = big(p);
    if (left <= 0n) break;
    if (side === "buy" ? px > lim : px < lim) break;
    const sz = big(s);
    const take = sz < left ? sz : left;
    cost += take * px;
    filled += take;
    left -= take;
  }
  return { avg: filled ? Number(cost / filled) / 1e12 : 0, filled: Number(filled) / 1e12, cost, filledB: filled };
}

describe("quote", () => {
  test("preview-equals-build", async () => {
    const books = fixture<{ coin: string; time: number; levels: { px: string; sz: string }[][] }[]>("l2Book_50core");
    expect(books.length).toBe(50);
    let n = 0;
    for (const [i, raw] of books.entries()) {
      const now = raw.time + 500;
      const { deps, cache } = setup();
      const id = `hyperliquid:-:${raw.coin}`;
      const m = await deps.reader.instrument(id);
      const ob = { marketId: id, bids: raw.levels[0]!.map((l) => [l.px, l.sz] as [string, string]), asks: raw.levels[1]!.map((l) => [l.px, l.sz] as [string, string]), asOf: new Date(raw.time).toISOString() };
      await cache.putBook(ob);
      const side = i % 2 === 0 ? "buy" : "sell";
      const lv = side === "buy" ? ob.asks : ob.bids;
      // a size that needs about three levels, at the market's lot size
      const want = lv.slice(0, 3).reduce((s, [, sz]) => s + Number(sz), 0) * 0.9;
      const size = want.toFixed(m.szDecimals);
      if (Number(size) <= 0) continue;
      const slip = 30 + (i % 5) * 20;
      const b = await buildOrder({ marketId: id, side, size, type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: slip }, ctx({ nowMs: now }), deps);
      const w = (b.payload.action as any).orders[0];
      const mid = Number(midOf(ob));
      // the protective limit is inside the slippage bound
      if (side === "buy") expect(Number(w.p)).toBeLessThanOrEqual(mid * (1 + slip / 10_000) + 1e-9);
      else expect(Number(w.p)).toBeGreaterThanOrEqual(mid * (1 - slip / 10_000) - 1e-9);
      const ind = walk(lv, side, w.s, w.p);
      expect(Number(b.preview.filledSize)).toBeCloseTo(ind.filled, 9);
      if (b.preview.quoteStatus === "ok") {
        // preview avg (12 decimals) x filled equals the exact cost within half a unit of the 12th decimal per unit filled
        const diff = big(b.preview.avgFillPx!) * ind.filledB - ind.cost;
        expect((diff < 0n ? -diff : diff) * 2n <= ind.filledB).toBe(true);
        // the fill is never worse than the bound
        const worse = side === "buy" ? (ind.avg - mid) / mid : (mid - ind.avg) / mid;
        expect(worse * 10_000).toBeLessThanOrEqual(slip + 1e-9);
        expect(b.preview.slippageBps).toBeCloseTo(worse * 10_000, 3);
      }
      expect(b.preview.totalCostBps).toBeCloseTo(b.preview.venueFeeBps + b.preview.builderFeeBps + b.preview.slippageBps + b.preview.fundingCostBps, 3);
      expect(fx(w.p) > 0n).toBe(true);
      n++;
    }
    expect(n).toBe(50);
  });
});
