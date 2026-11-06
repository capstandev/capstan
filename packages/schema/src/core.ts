// Canonical schema (spec section 3) with the research amendments, each marked with the research row it comes from.
// Amounts and prices are decimal strings end to end; no float ever carries money.
import type { Hex, VenueId, VenueIdentity } from "./adapter";

export type CanonicalAsset = `${"CR" | "EQ" | "ETF" | "IX" | "FX" | "CM" | "RT" | "VX" | "PI"}:${string}`;
// CR crypto, EQ equity, ETF fund, IX index, FX currency pair, CM commodity, RT rates, VX volatility, PI pre-IPO
export const CANONICAL_CLASSES = ["CR", "EQ", "ETF", "IX", "FX", "CM", "RT", "VX", "PI"] as const;
export type CanonicalClass = (typeof CANONICAL_CLASSES)[number];

/** Weekly trading window in the venue's time zone; `null` session hours on a market means 24/7. */
export interface SessionWindow {
  days: number[]; // 0 = Sunday ... 6 = Saturday
  open: string; // "09:30"
  close: string; // "16:00"
  tz: string; // IANA zone, e.g. "America/New_York"
}

export type EligibilityCode =
  | "GEO_REFUSED"
  | "DECLARATION_MISSING"
  | "VENUE_DATA_ONLY"
  | "MARKET_NOT_EXECUTABLE"
  | "POLICY_BREACH"
  | "BUILDER_APPROVAL_REQUIRED";

export interface Market {
  id: string; // marketId(): `${venue}:${dex ?? '-'}:${symbol}` e.g. 'hyperliquid:xyz:TSLA', 'hyperliquid:-:ETH'
  venue: VenueId;
  dex: string | null; // HIP-3 prefix ('xyz', 'io', 'para', 'mkts', ...) or null for core
  venueSymbol: string; // as the venue writes it ('xyz:TSLA', 'ETH', 'BTCUSDT', ...)
  // Research row 20 (Lighter-RH lists spot markets) and the Variational 'swap' contracts: only 'perp' can execute.
  marketType: "perp" | "spot" | "other";
  canonicalAsset: CanonicalAsset | null; // null until mapped and reviewed
  // Research row 11: HIP-3 collateral differs per dex (USDH, USDE, USDT0), Aster per symbol (USDT, USD1, USDC, U).
  collateralAsset: "USDC" | "USDG" | "USDT" | "USDF" | "MULTI" | string;
  tickSize: string;
  lotSize: string;
  minNotional: string | null;
  maxLeverage: number | null;
  // Research row 11: read from venue meta (most HIP-3 markets are isolated-only via noCross / strictIsolated).
  marginModes: ("cross" | "isolated")[];
  fundingIntervalS: number; // calculation window (HL 28800)
  fundingSettleIntervalS: number; // settlement cadence (HL 3600)
  sessionHours: SessionWindow[] | null; // null = 24/7
  oiCapUsd: string | null; // HIP-3 per-market caps
  builderFeeUnit: "tenths_bp" | "decimal_rate" | "ppm" | null;
  // Research row 11 (HIP-3 meta): deployer fee scale (0 to 300% of the base fee) and growth-mode flag, as published.
  deployerFeeScale?: string;
  growthMode?: boolean;
  // Raw index in the venue universe (HIP-3 asset ids count delisted entries); never recomputed from a filtered list.
  venueIndex?: number | null;
  // Catalog review inputs (todo 03): the asset class the venue metadata states (Aster symbolType 1 = a stock perp,
  // Arcus category), the contract multiplier and the oracle source. They feed alias proposals and the contract-spec
  // diff; they never map a market by themselves.
  assetClassHint?: CanonicalClass | null;
  contractMultiplier?: string; // "1" when the venue states none
  oracleSource?: string | null;
  status: "active" | "reduce_only" | "delisted" | "unknown";
  executable: boolean; // false for variational/arcus and for refused or unreviewed markets
  // Research row 26: Variational data is 8 to 67 s old by design (CDN cache), labelled 'delayed'.
  dataFreshness: "live" | "delayed";
  updatedAt: string;
}

export interface FundingSnapshot {
  marketId: string;
  ratePerInterval: string; // venue-native, as published
  intervalS: number;
  ratePerHour: string; // normalised
  rateAnnualised: string; // ratePerHour x 8760 (display only, labelled "observed, annualised")
  predictedNext: string | null;
  nextSettlementAt: string;
  capPerHour: string | null; // HL 4%/h
  source: "venue" | "forecast";
  asOf: string;
}

export interface OrderBook {
  marketId: string;
  bids: [px: string, sz: string][];
  asks: [px: string, sz: string][];
  asOf: string;
  seq?: number;
}

export interface QuoteRequest {
  canonicalAsset?: CanonicalAsset;
  marketIds?: string[];
  side: "buy" | "sell";
  sizeBase?: string;
  notionalUsd?: string;
  leverage: number;
  holdHours: number;
  orderType: "market" | "limit";
  limitPx?: string;
  owner?: Hex; // for eligibility, fee tier and existing-position checks
}

export interface VenueQuote {
  marketId: string;
  venue: VenueId;
  status: "ok" | "refused" | "data_only" | "insufficient_depth";
  refusal?: { code: EligibilityCode; reason: string };
  avgFillPx: string;
  slippageBps: number;
  venueFeeBps: number; // taker fee for the owner's tier if known, else base
  builderFeeBps: number; // Capstan's fee; 0 on Lighter
  fundingCostBps: number; // ratePerHour x holdHours, sign-aware
  totalCostBps: number;
  estLiqPx: string | null; // venue-specific margin model; null if unknown
  collateralAsset: string;
  asOf: string;
  staleMs: number;
}

export interface RouteQuote {
  requestId: string;
  legs: VenueQuote[];
  best: string | null;
  ranking: string[];
  receiptHint: string;
}

export interface OrderIntent {
  marketId: string;
  side: "buy" | "sell";
  size: string;
  type: "market" | "limit";
  limitPx?: string;
  tif: "ioc" | "gtc" | "alo";
  reduceOnly: boolean;
  leverage?: number;
  clientOrderId?: string;
  maxSlippageBps: number;
}

export interface Order {
  venue: VenueId;
  marketId: string;
  venueOrderId: string;
  clientOrderId?: string;
  side: "buy" | "sell";
  size: string;
  filled: string;
  px: string | null;
  status: "open" | "filled" | "cancelled" | "rejected" | "partial";
  builderFeeBps: number;
  createdAt: string;
}

export interface Fill {
  venue: VenueId;
  marketId: string;
  venueOrderId: string;
  px: string;
  sz: string;
  feeUsd: string;
  builderFeeUsd: string;
  ts: string;
  txHash?: string;
}

export interface Position {
  venue: VenueId;
  marketId: string;
  canonicalAsset: CanonicalAsset | null;
  side: "long" | "short";
  size: string;
  entryPx: string;
  markPx: string;
  notionalUsd: string;
  leverage: number;
  marginMode: "cross" | "isolated";
  liqPx: string | null; // venue-reported where available; else computed and flagged
  liqPxSource: "venue" | "computed";
  marginRatio: string | null;
  unrealisedPnlUsd: string;
  collateralAsset: string;
  asOf: string;
}

/** One venue account, as that venue reports it. Snapshots are never merged across venues (invariant 3). */
export interface AccountSnapshot {
  venue: VenueId;
  identity: VenueIdentity;
  equityUsd: string;
  freeCollateralUsd: string;
  positions: Position[];
  asOf: string;
}

export const RISK_BANNER = "Each venue liquidates independently. Nothing here is shared margin." as const;

export interface RiskView {
  owner: Hex | null;
  addresses: VenueIdentity[];
  perVenue: AccountSnapshot[]; // never merged
  exposureByAsset: { canonicalAsset: CanonicalAsset; grossUsd: string; netUsd: string; legs: string[] }[];
  liquidationLadder: { marketId: string; venue: VenueId; liqPx: string | null; distancePct: number | null }[];
  stress: { canonicalAsset: CanonicalAsset; shockPct: number; venuesLiquidated: VenueId[] }[];
  banner: typeof RISK_BANNER;
  asOf: string;
}

/**
 * Spec 3 market id: `${venue}:${dex ?? '-'}:${symbol}`, e.g. 'hyperliquid:xyz:TSLA' for venueSymbol 'xyz:TSLA' (the
 * dex prefix is not repeated) and 'hyperliquid:-:BTC' for core. Lighter ids differ per config by venue.
 */
export function marketId(venue: VenueId, dex: string | null, venueSymbol: string): string {
  const sym = dex !== null && venueSymbol.startsWith(`${dex}:`) ? venueSymbol.slice(dex.length + 1) : venueSymbol;
  return `${venue}:${dex ?? "-"}:${sym}`;
}
