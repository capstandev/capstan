// Quote: a pure book walk on the cached book plus the fee schedule and funding (spec 2 "quote is a pure function").
// The order build reuses the same walk at the built limit price, so the preview is exactly what the order would fill
// against that book (QUOTE-1, quote == execution).
import { Dec, type FundingSnapshot, type OrderBook, type VenueQuote, type VenueQuoteRequest } from "@capstan/schema";

const S = 18;
const ONE = 10n ** BigInt(S);

export function fx(s: string): bigint {
  return Dec.parse(s, S, "down").v;
}
export function fxStr(v: bigint, decimals = 12): string {
  return Dec.toString(Dec.rescale(Dec.fromBigInt(v, S), decimals, "half_even"));
}
function bpsOf(numFx: bigint, denFx: bigint): number {
  if (denFx === 0n) return 0;
  // numFx / denFx * 1e4, 4 decimals
  return Number((numFx * 10_000n * 10_000n) / denFx) / 10_000;
}

/** Hyperliquid perps fee tiers by 14-day volume (docs trading_fees.md and the live `userFees.feeSchedule`, 2026-11-06). */
export const HL_FEE_TIERS = [
  { tier: "0", ntlCutoff: "0", taker: "0.00045", maker: "0.00015" },
  { tier: "1", ntlCutoff: "5000000", taker: "0.0004", maker: "0.00012" },
  { tier: "2", ntlCutoff: "25000000", taker: "0.00035", maker: "0.00008" },
  { tier: "3", ntlCutoff: "100000000", taker: "0.0003", maker: "0.00004" },
  { tier: "4", ntlCutoff: "500000000", taker: "0.00028", maker: "0" },
  { tier: "5", ntlCutoff: "2000000000", taker: "0.00026", maker: "0" },
  { tier: "6", ntlCutoff: "7000000000", taker: "0.00024", maker: "0" },
] as const;

export interface HlFeeTier {
  takerRate: string; // decimal rate, 0.00045 = 4.5 bps
  makerRate: string;
  source: "base" | "user";
}

export const HL_BASE_FEES: HlFeeTier = { takerRate: HL_FEE_TIERS[0].taker, makerRate: HL_FEE_TIERS[0].maker, source: "base" };

export function rateToBps(rate: string): number {
  return bpsOf(fx(rate), ONE);
}

export interface WalkResult {
  filled: string;
  avgPx: string | null;
  complete: boolean;
  levelsUsed: number;
}

/**
 * Walk one side of the book for `size`, never past `limitPx` (buys take asks up to the limit, sells take bids down to
 * it). Prices and sizes are decimal strings; the average is rounded half-even to 12 decimals.
 */
export function walkBook(book: OrderBook, side: "buy" | "sell", size: string, limitPx: string | null): WalkResult {
  const levels = side === "buy" ? book.asks : book.bids;
  let left = fx(size);
  let filled = 0n;
  let cost = 0n; // scaled 1e36
  let used = 0;
  const lim = limitPx === null ? null : fx(limitPx);
  for (const [pxS, szS] of levels) {
    if (left <= 0n) break;
    const px = fx(pxS);
    if (lim !== null && (side === "buy" ? px > lim : px < lim)) break;
    const take = fx(szS) < left ? fx(szS) : left;
    filled += take;
    cost += take * px;
    left -= take;
    used++;
  }
  const avg = filled === 0n ? null : fxStr(cost / filled);
  return { filled: Dec.toString(Dec.fromBigInt(filled, S)), avgPx: avg, complete: left <= 0n, levelsUsed: used };
}

export function midOf(book: OrderBook): string | null {
  const b = book.bids[0]?.[0];
  const a = book.asks[0]?.[0];
  if (!b || !a) return null;
  return fxStr((fx(b) + fx(a)) / 2n);
}

/** Protective limit for a market order: mark x (1 +/- slippage). Rounding to the venue grid happens in the build. */
export function protectiveLimit(mark: string, side: "buy" | "sell", maxSlippageBps: number): string {
  if (!Number.isFinite(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 5000) throw new Error("maxSlippageBps must be 0..5000");
  const slip = BigInt(Math.round(maxSlippageBps * 100)); // bps x 100
  const m = fx(mark);
  const v = side === "buy" ? (m * (1_000_000n + slip)) / 1_000_000n : (m * (1_000_000n - slip)) / 1_000_000n;
  return fxStr(v);
}

export interface HlQuoteInput extends VenueQuoteRequest {
  /** Protective bound for market orders (bps from the reference price). */
  maxSlippageBps?: number;
  builderTenthsBp?: number; // 20, 10, or 0 when the builder field is off
  collateralAsset?: string;
  maxLeverage?: number | null;
  /** Reference price (mark); defaults to the book mid. */
  refPx?: string | null;
  nowMs?: number;
}

/** Simple isolated estimate, flagged computed: long liq = px x (1 - 1/lev + mmf), short = px x (1 + 1/lev - mmf), mmf = 1 / (2 x maxLeverage). */
export function estLiqPx(px: string, side: "buy" | "sell", leverage: number, maxLeverage: number | null | undefined): string | null {
  if (!Number.isFinite(leverage) || leverage <= 0 || !maxLeverage || maxLeverage <= 0) return null;
  const p = fx(px);
  const inv = ONE / BigInt(Math.round(leverage * 1000)) * 1000n;
  const mmf = ONE / BigInt(2 * maxLeverage);
  const f = side === "buy" ? ONE - inv + mmf : ONE + inv - mmf;
  if (f <= 0n) return null;
  return fxStr((p * f) / ONE, 8);
}

export function quote(req: HlQuoteInput, book: OrderBook, fees: HlFeeTier, funding?: FundingSnapshot | null): VenueQuote & { limitPx: string | null; filledSize: string } {
  const now = req.nowMs ?? Date.now();
  const ref = req.refPx ?? midOf(book);
  const base: Omit<VenueQuote, "status"> = {
    marketId: req.marketId,
    venue: "hyperliquid",
    avgFillPx: "0",
    slippageBps: 0,
    venueFeeBps: rateToBps(fees.takerRate),
    builderFeeBps: (req.builderTenthsBp ?? 0) / 10,
    fundingCostBps: 0,
    totalCostBps: 0,
    estLiqPx: null,
    collateralAsset: req.collateralAsset ?? "USDC",
    asOf: book.asOf,
    staleMs: Math.max(0, now - Date.parse(book.asOf)),
  };
  if (!ref) return { ...base, status: "insufficient_depth", limitPx: null, filledSize: "0" };
  let size = req.sizeBase;
  if (!size && req.notionalUsd) size = fxStr((fx(req.notionalUsd) * ONE) / fx(ref), 8);
  if (!size) throw new Error("quote needs sizeBase or notionalUsd");
  const limit = req.orderType === "limit" ? (req.limitPx ?? null) : req.maxSlippageBps !== undefined ? protectiveLimit(ref, req.side, req.maxSlippageBps) : null;
  const w = walkBook(book, req.side, size, limit);
  if (!w.complete || !w.avgPx) return { ...base, status: "insufficient_depth", limitPx: limit, filledSize: w.filled, avgFillPx: w.avgPx ?? "0" };
  const avg = fx(w.avgPx);
  const r = fx(ref);
  const worse = req.side === "buy" ? avg - r : r - avg;
  const slippageBps = bpsOf(worse, r);
  // funding: longs pay a positive rate, shorts receive it
  const fund = funding ? bpsOf(fx(funding.ratePerHour) * BigInt(Math.round(req.holdHours * 1000)) / 1000n, ONE) : 0;
  const fundingCostBps = req.side === "buy" ? fund : -fund;
  const venueFeeBps = base.venueFeeBps;
  const builderFeeBps = base.builderFeeBps;
  return {
    ...base,
    status: "ok",
    avgFillPx: w.avgPx,
    slippageBps,
    fundingCostBps,
    totalCostBps: Math.round((venueFeeBps + builderFeeBps + slippageBps + fundingCostBps) * 10_000) / 10_000,
    estLiqPx: estLiqPx(w.avgPx, req.side, req.leverage, req.maxLeverage),
    limitPx: limit,
    filledSize: w.filled,
  };
}
