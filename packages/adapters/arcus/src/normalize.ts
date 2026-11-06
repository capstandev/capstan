// Arcus public market data to the canonical schema (venue-readonly.md section 2, checked live 2026-11-05).
// Units differ per field, so every timestamp goes through ARCUS_UNITS (one contract test per field):
//   nextFundingAt, addedTimestamp: seconds; fundingRates[].time, bbo.timestamp: microseconds; /v1/time timeNs: nanoseconds.
// Funding is hourly, so ratePerHour = fundingRate; the rate is stored "longs pay when positive", the venue's convention.
import { Dec, marketId, VENUE_FUNDING_FACTS, type CanonicalClass, type FundingSnapshot, type Market, type OrderBook, type SessionWindow } from "@capstan/schema";

export interface ArcusMarket {
  marketDisplayName: string; // BTC-USD
  marketId: number;
  status: "ONLINE" | "OFFLINE" | string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: string;
  stepSize: string;
  minOrderNotional: string | null;
  oraclePrice: string | null;
  markPrice: string | null;
  fundingRate: string | null;
  nextFundingRate: string | null;
  nextFundingAt: number | null; // seconds
  openInterest: string | null;
  openInterestCapNotional: string | null;
  initialMarginFraction: string | null;
  maintenanceMarginFraction: string | null;
  regularTradingHours: { startSecondsOfDay: number; endSecondsOfDay: number; timezone: string; isOvernight: boolean } | null;
  type: "PERPETUAL" | string;
  category: "CRYPTO" | "EQUITIES" | "INDICES" | "COMMODITIES" | string;
  addedTimestamp?: number; // seconds
  pythId?: string | null;
  baseTakerFeePpm?: number;
}

export interface ArcusMarkets {
  markets: ArcusMarket[];
}
export interface ArcusBook {
  bids: [string, string][];
  asks: [string, string][];
}
export interface ArcusBbo {
  bestBid: { price: string; size: string } | null;
  bestAsk: { price: string; size: string } | null;
  timestamp: number; // microseconds
}
export interface ArcusFundingRow {
  marketId: number;
  marketDisplayName: string;
  fundingRate: string;
  time: number; // microseconds
}

/** One place for Arcus time units. Every function returns milliseconds since the epoch. */
export const ARCUS_UNITS = {
  /** nextFundingAt, addedTimestamp */
  seconds(v: number): number {
    if (!Number.isFinite(v)) throw new Error("arcus: bad seconds");
    return v * 1000;
  },
  /** fundingRates[].time, bbo.timestamp */
  micros(v: number | string | bigint): number {
    return Number(BigInt(v) / 1000n);
  },
  /** GET /v1/time timeNs, X-Timestamp */
  nanos(v: number | string | bigint): number {
    return Number(BigInt(v) / 1_000_000n);
  },
} as const;

export const ARCUS_FIELD_UNITS = {
  nextFundingAt: "seconds",
  addedTimestamp: "seconds",
  "fundingRates[].time": "micros",
  "bbo.timestamp": "micros",
  timeNs: "nanos",
} as const satisfies Record<string, keyof typeof ARCUS_UNITS>;

export const ARCUS_VENUE = "arcus" as const;
/** Published funding cap: plus or minus 4% per hour. */
export const ARCUS_CAP_PER_HOUR = VENUE_FUNDING_FACTS.arcus.capPerHour;

export function arcusMarketId(displayName: string): string {
  return marketId(ARCUS_VENUE, null, displayName);
}

export function displayNameOf(id: string): string {
  const p = `${ARCUS_VENUE}:-:`;
  if (!id.startsWith(p)) throw new Error(`not an Arcus market id: ${id}`);
  return id.slice(p.length);
}

const CATEGORY_HINT: Record<string, CanonicalClass> = { CRYPTO: "CR", EQUITIES: "EQ", INDICES: "IX", COMMODITIES: "CM" };

function hhmm(secondsOfDay: number): string {
  const h = Math.floor(secondsOfDay / 3600);
  const m = Math.floor((secondsOfDay % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Regular trading hours. Weekdays are inferred (US equity sessions); the venue states only the clock window. */
export function sessionHoursOf(rth: ArcusMarket["regularTradingHours"]): SessionWindow[] | null {
  if (!rth) return null;
  return [{ days: [1, 2, 3, 4, 5], open: hhmm(rth.startSecondsOfDay), close: hhmm(rth.endSecondsOfDay), tz: rth.timezone }];
}

function maxLeverageOf(imf: string | null): number | null {
  if (!imf) return null;
  const v = Number(imf);
  return v > 0 ? Math.floor(1 / v + 1e-9) : null;
}

export function normalizeMarket(m: ArcusMarket, updatedAt: string): Market {
  return {
    id: arcusMarketId(m.marketDisplayName),
    venue: ARCUS_VENUE,
    dex: null,
    venueSymbol: m.marketDisplayName,
    marketType: m.type === "PERPETUAL" ? "perp" : "other",
    canonicalAsset: null,
    collateralAsset: "USDG",
    tickSize: m.tickSize,
    lotSize: m.stepSize,
    minNotional: m.minOrderNotional ?? null,
    maxLeverage: maxLeverageOf(m.initialMarginFraction),
    marginModes: [], // not stated by the public market data
    fundingIntervalS: 3600,
    fundingSettleIntervalS: 3600,
    sessionHours: sessionHoursOf(m.regularTradingHours),
    oiCapUsd: m.openInterestCapNotional ?? null,
    builderFeeUnit: null,
    venueIndex: m.marketId,
    assetClassHint: CATEGORY_HINT[m.category] ?? null,
    contractMultiplier: "1",
    oracleSource: m.pythId ? `pyth:${m.pythId}` : null,
    status: m.status === "ONLINE" ? "active" : "unknown",
    executable: false,
    dataFreshness: "live",
    updatedAt,
  };
}

const S = 18;
const d = (s: string) => Dec.parse(s, S, "half_even");

export function normalizeFunding(m: ArcusMarket, asOfMs: number): FundingSnapshot | null {
  if (m.fundingRate === null || m.fundingRate === undefined) return null;
  const perHour = Dec.toString(d(m.fundingRate));
  return {
    marketId: arcusMarketId(m.marketDisplayName),
    ratePerInterval: perHour,
    intervalS: 3600,
    ratePerHour: perHour,
    rateAnnualised: Dec.toString(Dec.mul(d(perHour), Dec.parse("8760", 0), S)),
    predictedNext: m.nextFundingRate ?? null,
    nextSettlementAt: new Date(ARCUS_UNITS.seconds(m.nextFundingAt ?? Math.ceil(asOfMs / 3_600_000) * 3600)).toISOString(),
    capPerHour: ARCUS_CAP_PER_HOUR,
    source: "venue",
    asOf: new Date(asOfMs).toISOString(),
  };
}

export function markOf(m: ArcusMarket, asOfMs: number): { marketId: string; mark: string; index: string | null; oiUsd: string | null; asOf: string } | null {
  if (!m.markPrice) return null;
  const oiUsd = m.openInterest ? Dec.toString(Dec.mul(d(m.openInterest), d(m.markPrice), 8)) : null;
  return { marketId: arcusMarketId(m.marketDisplayName), mark: m.markPrice, index: m.oraclePrice ?? null, oiUsd, asOf: new Date(asOfMs).toISOString() };
}

export function normalizeBook(id: string, b: ArcusBook, asOfMs: number): OrderBook {
  return { marketId: id, bids: b.bids.map(([p, s]) => [p, s]), asks: b.asks.map(([p, s]) => [p, s]), asOf: new Date(asOfMs).toISOString() };
}

export function fundingHistoryRow(r: ArcusFundingRow): { marketId: string; ratePerHour: string; ts: string } {
  return { marketId: arcusMarketId(r.marketDisplayName), ratePerHour: r.fundingRate, ts: new Date(ARCUS_UNITS.micros(r.time)).toISOString() };
}
