// Venue units and market mapping. Lighter prices and sizes are integers scaled by each market's price_decimals and
// size_decimals (read per exchange from orderBookDetails; a mainnet market index never says anything about RH).
import { CapstanError, Dec, marketId, type Market, type Rounding, type SessionWindow } from "@capstan/schema";
import type { LighterConfig, LighterVenue } from "./config";

/** Lighter caps base amounts and indexes at 2^48 - 1; prices are uint32 in the signer. */
export const MAX_BASE_UNITS = 2 ** 48 - 1;
export const MAX_PRICE_UNITS = 2 ** 32 - 1;
/** Margin fractions are in ticks of 1e4 (666 = 6.66%). */
export const MARGIN_TICKS = 10_000;

export interface LighterBookRaw {
  symbol: string;
  market_id: number;
  market_type: string;
  status: string;
  min_base_amount?: string;
  min_quote_amount?: string;
  size_decimals?: number;
  price_decimals?: number;
  supported_size_decimals?: number;
  supported_price_decimals?: number;
}

export interface LighterDetailRaw extends LighterBookRaw {
  multiplier?: string;
  default_initial_margin_fraction?: number;
  maintenance_margin_fraction?: number;
  mark_price?: string;
  index_price?: string;
  open_interest?: string | number;
  market_config?: { market_margin_mode?: number; force_reduce_only?: boolean; trading_hours?: string; hidden?: boolean };
  funding_clamp_small?: string;
  funding_clamp_big?: string;
  base_interest_rate?: string;
}

function decimals(name: string, d: unknown): number {
  if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 18) throw new CapstanError("VENUE_ERROR", `Lighter market has a bad ${name}: ${String(d)}`);
  return d;
}

/**
 * Decimal string to a venue integer. Sizes always round down (an order is never bigger than asked); prices round as
 * the caller says (the slippage bound decides the direction). Throws when the integer leaves the venue's range.
 */
export function toVenueUnits(value: string, decimalsN: number, rounding: Rounding, max: number = MAX_BASE_UNITS): number {
  const d = decimals("decimals", decimalsN);
  const v = Dec.parse(value, d, rounding).v;
  if (v < 0n || v > BigInt(max)) throw new CapstanError("INVALID_INPUT", `value ${value} is outside the venue range at ${d} decimals`);
  return Number(v);
}

export function sizeToUnits(size: string, sizeDecimals: number): number {
  return toVenueUnits(size, sizeDecimals, "down", MAX_BASE_UNITS);
}

export function priceToUnits(px: string, priceDecimals: number, rounding: Rounding): number {
  return toVenueUnits(px, priceDecimals, rounding, MAX_PRICE_UNITS);
}

/** Venue integer back to a decimal string with exactly `decimals` places. */
export function fromVenueUnits(units: number | bigint, decimalsN: number): string {
  const d = decimals("decimals", decimalsN);
  const v = typeof units === "bigint" ? units : BigInt(units);
  return Dec.toString(Dec.fromBigInt(v, d), { fixed: true });
}

export function stepOf(decimalsN: number): string {
  const d = decimals("decimals", decimalsN);
  return d === 0 ? "1" : `0.${"0".repeat(d - 1)}1`;
}

/** floor(1 / IMF), IMF in 1e4 ticks; null when the venue publishes no positive fraction. */
export function maxLeverageFromImf(imfTicks: unknown): number | null {
  if (typeof imfTicks !== "number" || !Number.isFinite(imfTicks) || imfTicks <= 0) return null;
  return Math.floor(MARGIN_TICKS / imfTicks);
}

/** market_config.market_margin_mode: 0 cross and isolated, 1 isolated only (docs: RWA market structure). */
export function marginModesOf(mode: unknown): ("cross" | "isolated")[] {
  if (mode === 0 || mode === undefined) return ["cross", "isolated"];
  if (mode === 1) return ["isolated"];
  return [];
}

/**
 * market_config.trading_hours. Empty means 24/7 (every Lighter market traded 24/7 on 2026-11-06, RWAs included). Any
 * other value has no documented format yet: the market is marked status 'unknown' (fail closed) until it is mapped.
 */
export function sessionHoursOf(raw: unknown): { hours: SessionWindow[] | null; known: boolean } {
  if (raw === undefined || raw === null || raw === "") return { hours: null, known: true };
  return { hours: null, known: false };
}

export function statusOf(book: LighterBookRaw, detail: LighterDetailRaw | undefined, hoursKnown: boolean): Market["status"] {
  // inactive is treated as delisted (DECISIONS #68): the row stays, nothing executes
  if (book.status === "inactive") return "delisted";
  if (book.status !== "active") return "unknown";
  if (!hoursKnown) return "unknown";
  if (detail?.market_config?.force_reduce_only) return "reduce_only";
  return "active";
}

export function marketTypeOf(t: unknown): Market["marketType"] {
  return t === "perp" ? "perp" : t === "spot" ? "spot" : "other";
}

/** Lighter market id: `${venue}:-:${symbol}`. The venue part keeps mainnet and RH apart even when indexes match. */
export function lighterMarketId(venue: LighterVenue, symbol: string): string {
  return marketId(venue, null, symbol);
}

export function toMarket(cfg: LighterConfig, book: LighterBookRaw, detail: LighterDetailRaw | undefined, nowIso: string): Market {
  const src = detail ?? book;
  const sizeDec = decimals("size_decimals", src.size_decimals ?? src.supported_size_decimals);
  const priceDec = decimals("price_decimals", src.price_decimals ?? src.supported_price_decimals);
  const { hours, known } = sessionHoursOf(detail?.market_config?.trading_hours);
  const marketType = marketTypeOf(book.market_type);
  return {
    id: lighterMarketId(cfg.venue, book.symbol),
    venue: cfg.venue,
    dex: null,
    venueSymbol: book.symbol,
    marketType,
    canonicalAsset: null,
    collateralAsset: cfg.collateral,
    tickSize: stepOf(priceDec),
    lotSize: stepOf(sizeDec),
    minNotional: src.min_quote_amount ?? null,
    maxLeverage: marketType === "perp" ? maxLeverageFromImf(detail?.default_initial_margin_fraction) : null,
    marginModes: marketType === "perp" ? marginModesOf(detail?.market_config?.market_margin_mode) : [],
    fundingIntervalS: 3600,
    fundingSettleIntervalS: 3600,
    sessionHours: hours,
    oiCapUsd: null,
    builderFeeUnit: "ppm",
    venueIndex: book.market_id,
    contractMultiplier: "1",
    oracleSource: null,
    status: statusOf(book, detail, known),
    executable: false, // only a catalog review turns a market on; spot never
    dataFreshness: "live",
    updatedAt: nowIso,
  };
}

/** Join orderBooks with orderBookDetails (perps and spot) by market index. */
export function toMarkets(cfg: LighterConfig, books: LighterBookRaw[], details: LighterDetailRaw[], nowIso: string): Market[] {
  const byIndex = new Map(details.map((d) => [d.market_id, d]));
  return books.map((b) => toMarket(cfg, b, byIndex.get(b.market_id), nowIso));
}
