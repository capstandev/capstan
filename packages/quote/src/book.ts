// Book walk (spec 2 "quote is a pure function of the cached book"). Exact decimals; the average fill is rounded
// half-even to 12 decimals and slippage is measured from the best price on the side taken.
import { Dec, type OrderBook } from "@capstan/schema";
import { BPS, d, str, toBps, ZERO } from "./dec";

export type Walk = { avgPx: string; filled: string; worstPx: string; slippageBps: number; levelsUsed: number } | { insufficient: true; filled: string; levelsUsed: number };

export function bestPx(book: OrderBook, side: "buy" | "sell"): string | null {
  return (side === "buy" ? book.asks : book.bids)[0]?.[0] ?? null;
}

export function midPx(book: OrderBook): string | null {
  const b = book.bids[0]?.[0];
  const a = book.asks[0]?.[0];
  if (!b || !a) return null;
  return str(Dec.div(Dec.add(d(b), d(a)), Dec.parse("2", 0), 12, "half_even"));
}

/** Notional resting on the side a taker hits (ties in the ranking go to the deeper book). */
export function sideDepthNotional(book: OrderBook, side: "buy" | "sell"): string {
  let t = ZERO;
  for (const [px, sz] of side === "buy" ? book.asks : book.bids) t = Dec.add(t, Dec.mul(d(px), d(sz), 18));
  return str(t);
}

/** Walk one side for sizeBase, never past limitPx (buys take asks up to it, sells take bids down to it). */
export function walkBook(book: OrderBook, side: "buy" | "sell", sizeBase: string, limitPx?: string): Walk {
  const levels = side === "buy" ? book.asks : book.bids;
  const want = d(sizeBase);
  if (Dec.cmp(want, ZERO) <= 0) throw new RangeError("walkBook: size must be above zero");
  const lim = limitPx === undefined ? null : d(limitPx);
  let left = want;
  let filled = ZERO;
  let cost = ZERO;
  let worst: string | null = null;
  let used = 0;
  for (const [pxS, szS] of levels) {
    if (Dec.cmp(left, ZERO) <= 0) break;
    const px = d(pxS);
    if (lim && (side === "buy" ? Dec.cmp(px, lim) > 0 : Dec.cmp(px, lim) < 0)) break;
    const take = Dec.min(left, d(szS));
    if (Dec.cmp(take, ZERO) <= 0) continue;
    filled = Dec.add(filled, take);
    cost = Dec.add(cost, Dec.mul(take, px, 18));
    left = Dec.sub(left, take);
    worst = pxS;
    used++;
  }
  if (Dec.cmp(left, ZERO) > 0 || worst === null) return { insufficient: true, filled: str(filled), levelsUsed: used };
  const avg = Dec.div(cost, filled, 12, "half_even"); // one rounding

  const best = d(levels[0]![0]);
  const worse = side === "buy" ? Dec.sub(avg, best) : Dec.sub(best, avg);
  return { avgPx: str(avg), filled: str(filled), worstPx: worst, slippageBps: toBps(Dec.div(Dec.mul(worse, BPS, 18), best, 4, "half_even")), levelsUsed: used };
}
