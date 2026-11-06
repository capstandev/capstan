// Order shape per venue (QUOTE-1, quote == execution): the size and limit price a venue's buildOrder would put on the
// wire for the same intent and the same cached book. The quote walks the book at exactly this size and limit, so the
// fill it shows is the fill the signed order can get. Where the adapter exports its rule, the shaper calls it:
//   hyperliquid: midOf, protectiveLimit (adapter-hyperliquid) and formatSize, formatPrice (signer-hl).
//   lighter:     sizeToUnits, priceToUnits, fromVenueUnits (adapter-lighter); the bound is inline in that buildOrder,
//                so lighterBound below copies it digit for digit.
//   aster:       size a multiple of the lot (never rounded up); market = IOC LIMIT at best x (1 +/- bps) on the tick,
//                buys rounded down and sells up (adapter-aster slippageBound); limit = the given price on the tick.
// test/quote1.test.ts runs every T1 shaper against the real adapter's buildOrder.
import { midOf as hlMidOf, protectiveLimit as hlProtectiveLimit } from "@capstan/adapter-hyperliquid";
import { fromVenueUnits, priceToUnits, sizeToUnits } from "@capstan/adapter-lighter";
import { CapstanError, Dec, type Market, type OrderBook, type VenueId } from "@capstan/schema";
import { formatPrice as hlFormatPrice, formatSize as hlFormatSize } from "@capstan/signer-hl";
import { bestPx } from "./book";
import { BPS, d, S, stepDecimals, str, ZERO } from "./dec";

/** Slippage bound a market quote assumes when the request names none (the same default as the Aster adapter). */
export const DEFAULT_MARKET_SLIPPAGE_BPS = 50;

export interface ShapeInput {
  market: Market;
  book: OrderBook;
  /** Fresh mark (under the staleness limit), or null. */
  mark: string | null;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  sizeBase: string;
  limitPx?: string;
  maxSlippageBps: number;
}

export interface Shape {
  size: string;
  limitPx: string;
}

export type LegShaper = (i: ShapeInput) => Shape;

function checkBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw new CapstanError("INVALID_INPUT", "maxSlippageBps must be an integer 0..5000");
}

function bound(ref: string, side: "buy" | "sell", bps: number): Dec {
  const f = Dec.parse(String(bps), 0);
  return Dec.div(Dec.mul(d(ref), side === "buy" ? Dec.add(BPS, f) : Dec.sub(BPS, f), S), BPS, S, "half_even");
}

function floorStep(x: string, step: string): string {
  if (!step || Dec.cmp(d(step), ZERO) <= 0) return x;
  return str(Dec.roundToStep(d(x), d(step), "down"));
}

function positive(x: string, what: string): string {
  if (Dec.cmp(d(x), ZERO) <= 0) throw new CapstanError("INVALID_INPUT", `${what} rounds to zero`);
  return x;
}

export const asterShaper: LegShaper = (i) => {
  checkBps(i.maxSlippageBps);
  const size = positive(floorStep(i.sizeBase, i.market.lotSize), "size");
  if (i.orderType === "limit") {
    if (!i.limitPx) throw new CapstanError("INVALID_INPUT", "a limit order needs limitPx");
    return { size, limitPx: str(Dec.roundToStep(d(i.limitPx), d(i.market.tickSize), i.side === "buy" ? "down" : "up")) };
  }
  const best = bestPx(i.book, i.side);
  if (!best) throw new CapstanError("STALE_QUOTE", "the book has no levels on that side");
  const px = Dec.roundToStep(bound(best, i.side, i.maxSlippageBps), d(i.market.tickSize), i.side === "buy" ? "down" : "up");
  return { size, limitPx: positive(str(px), "price") };
};

/**
 * Lighter's protective bound, written exactly as adapter-lighter's buildOrder writes it (12 decimals, half-even), so
 * the grid rounding that follows sees the same number. quote1.test.ts runs it against that buildOrder.
 */
function lighterBound(ref: string, side: "buy" | "sell", bps: number): string {
  const L = 12;
  const f = Dec.parse(String(bps), 0);
  const one = Dec.parse("10000", 0);
  return Dec.toString(Dec.div(Dec.mul(Dec.parse(ref, L, "half_even"), side === "buy" ? Dec.add(one, f) : Dec.sub(one, f), L), one, L, "half_even"));
}

/** Lighter: the size and price go through the adapter's own unit conversions (sizes never round up). */
export const lighterShaper: LegShaper = (i) => {
  checkBps(i.maxSlippageBps);
  const sizeDec = stepDecimals(i.market.lotSize);
  const pxDec = stepDecimals(i.market.tickSize);
  const dir = i.side === "buy" ? "down" : "up";
  let size: string;
  let limitPx: string;
  try {
    const units = sizeToUnits(i.sizeBase, sizeDec);
    if (units < 1) throw new CapstanError("INVALID_INPUT", "size rounds to zero");
    size = str(d(fromVenueUnits(units, sizeDec))); // the engine's plain form (no trailing zeros)
    let raw: string;
    if (i.orderType === "limit") {
      if (!i.limitPx) throw new CapstanError("INVALID_INPUT", "a limit order needs limitPx");
      raw = i.limitPx;
    } else {
      const ref = bestPx(i.book, i.side) ?? i.mark;
      if (!ref) throw new CapstanError("STALE_QUOTE", "no book or mark");
      raw = lighterBound(ref, i.side, i.maxSlippageBps);
    }
    const p = priceToUnits(raw, pxDec, dir);
    if (p < 1) throw new CapstanError("INVALID_INPUT", "price rounds to zero");
    limitPx = str(d(fromVenueUnits(p, pxDec)));
  } catch (e) {
    if (e instanceof CapstanError) throw e;
    throw new CapstanError("INVALID_INPUT", (e as Error).message);
  }
  return { size, limitPx };
};

/**
 * Hyperliquid: the adapter's own rules, called rather than restated. Reference = the fresh mark, else the book mid
 * (adapter-hyperliquid midOf); market bound = protectiveLimit; size = formatSize (down to szDecimals); price =
 * formatPrice on the venue grid, buys down and sells up.
 */
export const hyperliquidShaper: LegShaper = (i) => {
  checkBps(i.maxSlippageBps);
  const szDecimals = stepDecimals(i.market.lotSize);
  const dir = i.side === "buy" ? "down" : "up";
  let raw: string;
  if (i.orderType === "limit") {
    if (!i.limitPx) throw new CapstanError("INVALID_INPUT", "a limit order needs limitPx");
    raw = i.limitPx;
  } else {
    const ref = i.mark ?? hlMidOf(i.book);
    if (!ref) throw new CapstanError("STALE_QUOTE", "no two-sided book or fresh mark");
    raw = hlProtectiveLimit(ref, i.side, i.maxSlippageBps);
  }
  try {
    return { size: hlFormatSize(i.sizeBase, szDecimals), limitPx: hlFormatPrice(raw, szDecimals, dir) };
  } catch (e) {
    throw new CapstanError("INVALID_INPUT", (e as Error).message);
  }
};

/** Data-only venues: no order is ever built, so the indicative walk uses the size floored to the lot and no limit. */
export const indicativeShaper: LegShaper = (i) => ({ size: i.market.lotSize && Dec.cmp(d(i.market.lotSize), ZERO) > 0 ? positive(floorStep(i.sizeBase, i.market.lotSize), "size") : i.sizeBase, limitPx: "" });

export const DEFAULT_SHAPERS: Record<VenueId, LegShaper> = {
  hyperliquid: hyperliquidShaper,
  "lighter-mainnet": lighterShaper,
  "lighter-rh": lighterShaper,
  aster: asterShaper,
  variational: indicativeShaper,
  arcus: indicativeShaper,
};
