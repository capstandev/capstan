// Variational GET /metadata/v2/stats to the canonical schema (venue-readonly.md section 1, checked live 2026-11-05).
// Data is served from a 60 s CDN cache, so every market is 'delayed' and every asOf is the quote's own updated_at,
// never the fetch time. Funding: ratePerHour = interval_rate / (interval_seconds / 3600), annualised = perHour x 8760
// (equal to the venue's simple annualized_rate). Rates are stored "longs pay when positive", the venue's convention.
import { Dec, marketId, type CanonicalClass, type FundingSnapshot, type Market } from "@capstan/schema";
import type { QuoteBucket } from "./readonly";

export interface VariationalQuoteSide {
  bid: string;
  ask: string;
}

export interface VariationalListing {
  ticker: string; // BTC-PERP, XAU-SWAP
  name: string;
  contract_type: "perpetual" | "swap" | string;
  mark_price: string;
  volume_24h: string;
  open_interest: { long_open_interest: string; short_open_interest: string };
  // Perps carry one rate per interval. The 24 h swaps carry a long rate and a short rate instead, with no next.
  funding: {
    last: VariationalRate;
    next: VariationalRate | null;
    interval_seconds: number;
    next_timestamp: number | null; // seconds
  };
  base_spread_bps: string;
  // absent on a few illiquid swaps (COCOA-SWAP, USFNG-SWAP on 2026-11-06)
  quotes?: { updated_at: string; base: VariationalQuoteSide; size_1k: VariationalQuoteSide; size_100k: VariationalQuoteSide; size_1m?: VariationalQuoteSide } | null;
}

export interface VariationalRate {
  annualized_rate?: string;
  interval_rate?: string;
  annualized_long_rate?: string;
  annualized_short_rate?: string;
  interval_long_rate?: string;
  interval_short_rate?: string;
}

/**
 * The rate as "longs pay when positive". A perp has one interval_rate. A swap states what a long pays
 * (interval_long_rate) and what a short pays separately; the long side is the one this schema can carry, and swaps
 * are marketType 'other', so they never reach a quote or a spread.
 */
export function longRateOf(r: VariationalRate): string {
  const v = r.interval_rate ?? r.interval_long_rate;
  if (typeof v !== "string") throw new Error("variational: funding has no interval rate");
  return v;
}

/** Next settlement: the venue's next_timestamp (seconds), else the next interval boundary after asOf (swaps). */
export function nextSettlementOf(l: VariationalListing, asOf: string): string {
  if (typeof l.funding.next_timestamp === "number") return new Date(l.funding.next_timestamp * 1000).toISOString();
  const iv = l.funding.interval_seconds * 1000;
  const t = Date.parse(asOf);
  return new Date((Math.floor(t / iv) + 1) * iv).toISOString();
}

export interface VariationalStats {
  total_volume_24h: string;
  num_markets: number;
  listings: VariationalListing[];
}

const S = 18;
const d = (s: string) => Dec.parse(s, S, "half_even");
const str = (x: Dec) => Dec.toString(x);

export const VARIATIONAL_VENUE = "variational" as const;

export function variationalMarketId(ticker: string): string {
  return marketId(VARIATIONAL_VENUE, null, ticker);
}

export function tickerOf(id: string): string {
  const p = `${VARIATIONAL_VENUE}:-:`;
  if (!id.startsWith(p)) throw new Error(`not a Variational market id: ${id}`);
  return id.slice(p.length);
}

/**
 * Variational publishes no asset class. Tickers known to be non-crypto (read from the live list, 2026-11-06) are
 * tagged so the catalog never auto-maps them; an unknown ticker gets no hint (and only crypto majors auto-map anyway).
 */
const CLASS_TABLE: Record<Exclude<CanonicalClass, "CR" | "RT" | "FX">, readonly string[]> = {
  EQ: [
    "AAOI", "AAPL", "ADBE", "ALAB", "AMAT", "AMC", "AMD", "AMZN", "APP", "ARM", "ASML", "ASTS", "AVGO", "BABA", "BAC", "BBIT", "BE", "BMNR", "BRKB",
    "BX", "C", "CIEN", "COIN", "COST", "CRCL", "CRDO", "CRM", "CRWD", "CRWV", "CSCO", "CVNA", "DELL", "DIS", "DJT", "DKNG", "DRAM", "EBAY", "F",
    "FLNC", "GLW", "GME", "GOOGL", "GPRO", "HD", "HIMS", "HOOD", "HPE", "IBKR", "IBM", "INTC", "IONQ", "IREN", "JPM", "KLAC", "KO", "LITE", "LLY",
    "MARA", "MCD", "MDB", "META", "MRNA", "MRVL", "MSFT", "MSTR", "MU", "NBIS", "NFLX", "NOK", "NOW", "NVDA", "NVO", "ONDS", "ORCL", "PLTR",
    "QCOM", "RDDT", "RIVN", "RKLB", "SHOP", "SKHY", "SMCI", "SNDK", "SNOW", "SOFI", "SONY", "STRC", "TER", "TSLA", "TSM", "TTWO", "TXN", "UBER",
    "USAR", "VISA", "WMT", "XOM", "ZM",
  ],
  ETF: ["DIA", "EWJ", "EWT", "EWY", "EWZ", "IWM", "QQQ", "SOXL", "SOXS", "SQQQ", "TBT", "TMF", "TZA", "URNM", "UVXY", "XBI", "XLE"],
  IX: ["US500", "US100", "US30", "US2K", "US400", "CNA50", "DXI", "VXI", "TWI", "USFNG"],
  CM: ["XAU", "XAG", "XPD", "XPT", "COPPER", "COPP", "CL", "BZ", "NATGAS", "COCOA", "USOIL", "UKOIL", "HOIL", "GASOL"],
  VX: [],
  PI: ["ANTHROPIC", "OPENAI", "SPCX"],
};
const CLASS_OF = new Map<string, CanonicalClass>(Object.entries(CLASS_TABLE).flatMap(([cls, xs]) => xs.map((x) => [x, cls as CanonicalClass] as const)));

export function baseOfTicker(ticker: string): string {
  return ticker.replace(/-(PERP|SWAP)$/, "");
}

export function classHint(ticker: string): CanonicalClass | null {
  return CLASS_OF.get(baseOfTicker(ticker)) ?? null;
}

/** RFC 3339 with up to 9 fraction digits to an ISO string with milliseconds. */
export function isoMs(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(ts);
  if (!m) throw new Error(`bad timestamp ${ts.slice(0, 40)}`);
  const ms = Date.parse(`${m[1]}.${(m[2] ?? "").padEnd(3, "0").slice(0, 3)}${m[3]}`);
  if (!Number.isFinite(ms)) throw new Error(`bad timestamp ${ts.slice(0, 40)}`);
  return new Date(ms).toISOString();
}

/** The CDN snapshot time: the newest quote updated_at in the payload (every listing comes from the same snapshot). */
export function snapshotAsOf(listings: VariationalListing[]): string | null {
  let best: string | null = null;
  for (const l of listings) {
    if (!l.quotes?.updated_at) continue;
    const t = isoMs(l.quotes.updated_at);
    if (best === null || t > best) best = t;
  }
  return best;
}

/** A listing's asOf: its own quote time, else the snapshot time (never the fetch time). */
export function asOfOf(l: VariationalListing, fallback: string): string {
  return l.quotes?.updated_at ? isoMs(l.quotes.updated_at) : fallback;
}

export function normalizeMarket(l: VariationalListing, updatedAt: string): Market {
  const perp = l.contract_type === "perpetual";
  const ivS = l.funding.interval_seconds;
  return {
    id: variationalMarketId(l.ticker),
    venue: VARIATIONAL_VENUE,
    dex: null,
    venueSymbol: l.ticker,
    // the 24 h 'swap' contracts are not perps and never map or execute
    marketType: perp ? "perp" : "other",
    canonicalAsset: null,
    collateralAsset: "USDC", // docs: "prices and volumes are denominated in USDC"; no settlement field in the data
    tickSize: "0", // no order book: the venue publishes no tick or lot
    lotSize: "0",
    minNotional: null,
    maxLeverage: null,
    marginModes: [],
    fundingIntervalS: ivS,
    fundingSettleIntervalS: ivS,
    sessionHours: null,
    oiCapUsd: null,
    builderFeeUnit: null,
    venueIndex: null,
    assetClassHint: perp ? classHint(l.ticker) : (classHint(l.ticker) ?? "IX"),
    contractMultiplier: "1",
    oracleSource: null,
    status: "active",
    executable: false,
    dataFreshness: "delayed",
    updatedAt,
  };
}

export function ratePerHourOf(intervalRate: string, intervalS: number): string {
  if (!Number.isInteger(intervalS) || intervalS <= 0) throw new Error(`bad funding interval ${intervalS}`);
  // perHour = rate x 3600 / intervalS, exact at 18 decimals (half-even only past the 18th digit)
  return str(Dec.div(Dec.mul(d(intervalRate), Dec.parse("3600", 0), S), Dec.parse(String(intervalS), 0), S, "half_even"));
}

export function annualisedOf(ratePerHour: string): string {
  return str(Dec.mul(d(ratePerHour), Dec.parse("8760", 0), S));
}

export function normalizeFunding(l: VariationalListing, fallbackAsOf = ""): FundingSnapshot {
  const ivS = l.funding.interval_seconds;
  const asOf = asOfOf(l, fallbackAsOf);
  const perHour = ratePerHourOf(longRateOf(l.funding.last), ivS);
  return {
    marketId: variationalMarketId(l.ticker),
    ratePerInterval: str(d(longRateOf(l.funding.last))),
    intervalS: ivS,
    ratePerHour: perHour,
    rateAnnualised: annualisedOf(perHour),
    predictedNext: l.funding.next ? str(d(longRateOf(l.funding.next))) : null, // per interval, like ratePerInterval
    nextSettlementAt: nextSettlementOf(l, asOf),
    capPerHour: null,
    source: "venue",
    asOf,
  };
}

export function quoteBuckets(l: VariationalListing): QuoteBucket[] {
  if (!l.quotes) return [];
  const asOf = isoMs(l.quotes.updated_at);
  const out: QuoteBucket[] = [
    { size: "1k", bid: l.quotes.size_1k.bid, ask: l.quotes.size_1k.ask, asOf },
    { size: "100k", bid: l.quotes.size_100k.bid, ask: l.quotes.size_100k.ask, asOf },
  ];
  if (l.quotes.size_1m) out.push({ size: "1m", bid: l.quotes.size_1m.bid, ask: l.quotes.size_1m.ask, asOf });
  return out;
}

export function markOf(l: VariationalListing, fallbackAsOf = ""): { marketId: string; mark: string; asOf: string } {
  return { marketId: variationalMarketId(l.ticker), mark: l.mark_price, asOf: asOfOf(l, fallbackAsOf) };
}
