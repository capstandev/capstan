// Pure mapping from Aster V3 wire shapes to the canonical schema (spec 3 and 4.4, venue-aster.md section 2).
// No I/O here. Amounts stay decimal strings; the only arithmetic is on bigint decimals.
import { Dec, marketId, type FundingSnapshot, type Market, type MarketEvent, type OrderBook } from "@capstan/schema";

// ---------------------------------------------------------------- wire types (only the fields we read)
export interface AsterFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  notional?: string;
}

export interface AsterSymbolInfo {
  symbol: string;
  contractType: string; // PERPETUAL, or "" while PENDING_TRADING
  status: string; // TRADING | SETTLING | PENDING_TRADING | ...
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string; // USDT | USD1 | USDC | U
  underlyingType?: string; // COIN on every symbol: never use it to spot a stock
  underlyingSubType?: string[];
  symbolType?: number; // 1 = stock perp
  tradingMode?: number;
  requiredMarginPercent?: string;
  filters: AsterFilter[];
}

export interface AsterExchangeInfo {
  serverTime: number;
  rateLimits?: { rateLimitType: string; interval: string; intervalNum: number; limit: number }[];
  symbols: AsterSymbolInfo[];
}

export interface AsterFundingInfoRow {
  symbol: string;
  interestRate?: string;
  time?: number;
  fundingIntervalHours: number;
  fundingFeeCap: number | string;
  fundingFeeFloor: number | string;
}

export interface AsterPremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice?: string;
  lastFundingRate: string;
  interestRate?: string;
  nextFundingTime: number; // ms
  time: number; // ms
}

export interface AsterDepth {
  lastUpdateId: number | string;
  E?: number;
  T?: number;
  bids: [string, string][];
  asks: [string, string][];
}

export interface FundingInterval {
  hours: number;
  cap: string;
  floor: string;
}

// ---------------------------------------------------------------- helpers
const SCALE = 18;

/** A JSON number as a plain decimal string. String(1e-7) is "1e-7"; this never returns an exponent form. */
export function numberToDecimal(x: number | string): string {
  if (typeof x === "string") return Dec.toString(Dec.parse(x, SCALE, "half_even"));
  if (!Number.isFinite(x)) throw new RangeError("numberToDecimal: not finite");
  return Dec.toString(Dec.parse(String(x), SCALE, "half_even")); // Dec.parse reads exponent forms exactly
}

function divInt(a: string, n: number): string {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError("divInt: divisor must be a positive integer");
  return Dec.toString(Dec.div(Dec.parse(a, SCALE, "half_even"), Dec.parse(String(n), 0), SCALE, "half_even"));
}

function mulInt(a: string, n: number): string {
  return Dec.toString(Dec.mul(Dec.parse(a, SCALE, "half_even"), Dec.parse(String(n), 0), SCALE, "half_even"));
}

export const ASTER_VENUE = "aster" as const;

export function asterMarketId(symbol: string): string {
  return marketId(ASTER_VENUE, null, symbol);
}

/** `aster:-:BTCUSDT` -> `BTCUSDT`. Refuses ids of other venues. */
export function symbolOf(id: string): string {
  const prefix = "aster:-:";
  if (!id.startsWith(prefix) || id.length === prefix.length) throw new RangeError(`not an Aster market id: ${id}`);
  return id.slice(prefix.length);
}

// ---------------------------------------------------------------- status and class
export function mapStatus(status: string, contractType: string): Market["status"] {
  if (status === "TRADING") return contractType === "PERPETUAL" ? "active" : "unknown";
  if (status === "SETTLING") return "reduce_only";
  if (status === "PENDING_TRADING") return "unknown";
  return "delisted"; // CLOSE, DELIVERED and anything the venue adds later never routes
}

/** Stock perps: symbolType 1 or an underlyingSubType containing STOCK. underlyingType is COIN on every symbol. */
export function isEquityPerp(s: Pick<AsterSymbolInfo, "symbolType" | "underlyingSubType">): boolean {
  return s.symbolType === 1 || (s.underlyingSubType ?? []).some((t) => t.toUpperCase().includes("STOCK"));
}

export interface AsterMarket extends Market {
  isEquity: boolean;
}

/** Only TRADING perps that are not stock perps may ever be offered as executable candidates (a review still decides). */
export function isExecutableCandidate(m: Pick<Market, "status" | "marketType"> & { isEquity?: boolean }): boolean {
  return m.status === "active" && m.marketType === "perp" && m.isEquity !== true;
}

function filter(s: AsterSymbolInfo, type: string): AsterFilter | undefined {
  return s.filters.find((f) => f.filterType === type);
}

/** Max leverage from the base initial-margin percent (25% -> 4x). Null when the venue does not state it. */
export function maxLeverageOf(requiredMarginPercent: string | undefined): number | null {
  if (!requiredMarginPercent) return null;
  const p = Number(requiredMarginPercent);
  if (!Number.isFinite(p) || p <= 0) return null;
  return Math.floor(100 / p);
}

export function normalizeMarket(s: AsterSymbolInfo, interval: FundingInterval | undefined, nowIso: string): AsterMarket {
  const price = filter(s, "PRICE_FILTER");
  const lot = filter(s, "LOT_SIZE");
  const notional = filter(s, "MIN_NOTIONAL");
  if (!price?.tickSize || !lot?.stepSize) throw new RangeError(`aster ${s.symbol}: missing PRICE_FILTER or LOT_SIZE`);
  const equity = isEquityPerp(s);
  // Aster defaults to 8 h funding; a symbol missing from fundingInfo is a non-routed symbol, so the default is safe.
  const hours = interval?.hours ?? 8;
  return {
    id: asterMarketId(s.symbol),
    venue: ASTER_VENUE,
    dex: null,
    venueSymbol: s.symbol,
    marketType: s.contractType === "PERPETUAL" ? "perp" : "other",
    canonicalAsset: null, // mapped only by the catalog rules (03), never here
    collateralAsset: s.marginAsset,
    tickSize: price.tickSize,
    lotSize: lot.stepSize,
    minNotional: notional?.notional ?? null,
    maxLeverage: maxLeverageOf(s.requiredMarginPercent),
    marginModes: ["cross", "isolated"],
    fundingIntervalS: hours * 3600,
    fundingSettleIntervalS: hours * 3600,
    sessionHours: null,
    oiCapUsd: null,
    builderFeeUnit: "decimal_rate",
    venueIndex: null,
    assetClassHint: equity ? "EQ" : null,
    contractMultiplier: "1",
    oracleSource: "aster_index",
    status: mapStatus(s.status, s.contractType),
    executable: false, // only a catalog review turns a market on
    dataFreshness: "live",
    updatedAt: nowIso,
    isEquity: equity,
  };
}

// ---------------------------------------------------------------- funding
export function fundingIntervalsFrom(rows: AsterFundingInfoRow[]): Record<string, FundingInterval> {
  const out: Record<string, FundingInterval> = {};
  for (const r of rows) {
    if (!Number.isInteger(r.fundingIntervalHours) || r.fundingIntervalHours <= 0) continue;
    out[r.symbol] = { hours: r.fundingIntervalHours, cap: numberToDecimal(r.fundingFeeCap), floor: numberToDecimal(r.fundingFeeFloor) };
  }
  return out;
}

/** Observed rate normalised per hour; annualised = per hour x 8760 (display only, labelled observed). */
export function normalizeFunding(p: Pick<AsterPremiumIndex, "symbol" | "lastFundingRate" | "nextFundingTime" | "time">, interval: FundingInterval): FundingSnapshot {
  const perHour = divInt(p.lastFundingRate, interval.hours);
  return {
    marketId: asterMarketId(p.symbol),
    ratePerInterval: numberToDecimal(p.lastFundingRate),
    intervalS: interval.hours * 3600,
    ratePerHour: perHour,
    rateAnnualised: mulInt(perHour, 8760),
    predictedNext: null,
    nextSettlementAt: new Date(Number(p.nextFundingTime)).toISOString(),
    capPerHour: divInt(interval.cap, interval.hours),
    source: "venue",
    asOf: new Date(Number(p.time)).toISOString(),
  };
}

// ---------------------------------------------------------------- books
export function normalizeBook(symbol: string, d: AsterDepth, fallbackMs: number): OrderBook {
  const seq = Number(d.lastUpdateId);
  return {
    marketId: asterMarketId(symbol),
    bids: d.bids.map(([px, sz]) => [px, sz] as [string, string]),
    asks: d.asks.map(([px, sz]) => [px, sz] as [string, string]),
    asOf: new Date(Number(d.T ?? d.E ?? fallbackMs)).toISOString(),
    ...(Number.isSafeInteger(seq) ? { seq } : {}),
  };
}

// ---------------------------------------------------------------- WebSocket
export interface WsDepthEvent {
  e: "depthUpdate";
  E: number;
  T?: number;
  s: string;
  u?: number;
  b: [string, string][];
  a: [string, string][];
}

export interface WsMarkEvent {
  e: "markPriceUpdate";
  E: number;
  s: string;
  p: string; // mark
  i: string; // index
  P?: string;
  r: string; // funding rate for the current interval
  T: number; // next funding time, ms
}

type LooseWsEvent = { e?: string; E?: number; T?: number; s?: string; u?: number; p?: string; i?: string; r?: string; b?: [string, string][]; a?: [string, string][] } | null;

/** Stream names: `<symbol lowercase>@depth20@100ms` per routed symbol, plus `!markPrice@arr` for every mark. */
export function depthStream(symbol: string): string {
  return `${symbol.toLowerCase()}@depth20@100ms`;
}
export const MARK_ARR_STREAM = "!markPrice@arr";

/**
 * Turn one WS message into canonical events. Accepts raw (`/ws`) and wrapped (`/stream`, `{stream, data}`) forms.
 * `wanted` limits events to those symbols; `allMarks` keeps marks and funding for every symbol (ingest).
 * Funding events need the per-symbol interval; a symbol with no known interval yields a mark event only.
 */
export function wsEvents(msg: unknown, intervals: Record<string, FundingInterval>, wanted?: Set<string>, opts: { allMarks?: boolean } = {}): MarketEvent[] {
  const data = msg && typeof msg === "object" && !Array.isArray(msg) && "data" in (msg as object) ? (msg as { data: unknown }).data : msg;
  const out: MarketEvent[] = [];
  const marks = Array.isArray(data) ? data : [data];
  for (const m of marks as LooseWsEvent[]) {
    if (!m || typeof m !== "object" || typeof m.s !== "string") continue;
    const isWanted = !wanted || wanted.has(m.s);
    if (m.e === "markPriceUpdate" && typeof m.p === "string") {
      if (!isWanted && !opts.allMarks) continue;
      const asOf = new Date(Number(m.E)).toISOString();
      out.push({ kind: "mark", marketId: asterMarketId(m.s), mark: m.p, ...(m.i ? { index: m.i } : {}), asOf });
      const iv = intervals[m.s];
      if (iv && typeof m.r === "string" && typeof m.T === "number") {
        out.push({ kind: "funding", funding: normalizeFunding({ symbol: m.s, lastFundingRate: m.r, nextFundingTime: m.T, time: m.E! }, iv) });
      }
    } else if (m.e === "depthUpdate" && isWanted && Array.isArray(m.b) && Array.isArray(m.a)) {
      out.push({ kind: "book", book: normalizeBook(m.s, { lastUpdateId: m.u ?? 0, E: m.E, T: m.T, bids: m.b, asks: m.a }, Number(m.E)) });
    }
  }
  return out;
}
