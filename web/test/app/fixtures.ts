// Fixtures shared by the dashboard tests and the browser pass: a quote with a data-only row and a two-venue risk view.
import { RISK_BANNER, type RiskView, type RouteQuote } from "../../src/lib/capstan";

const leg = (marketId: string, venue: string, status: string, o: Partial<Record<string, unknown>> = {}) => ({ marketId, venue, status, avgFillPx: "347.70", slippageBps: 1.5, venueFeeBps: 4.5, builderFeeBps: 2, fundingCostBps: 24, totalCostBps: 32, estLiqPx: "452.10", collateralAsset: "USDC", asOf: "2026-11-06T01:00:00.000Z", staleMs: 200, ...o });

export function quote(best: string): RouteQuote {
  return {
    requestId: "q1",
    legs: [
      leg("hyperliquid:xyz:TSLA", "hyperliquid", "ok"),
      leg("lighter-rh:-:TSLA", "lighter-rh", "ok", { builderFeeBps: 0, venueFeeBps: 0, fundingCostBps: 12, estLiqPx: "455.00", collateralAsset: "USDG" }),
      leg("variational:-:TSLA", "variational", "data_only", { builderFeeBps: 0, venueFeeBps: 0, slippageBps: 0.5, estLiqPx: null }),
    ],
    best,
    ranking: [best],
    receiptHint: "",
  } as unknown as RouteQuote;
}

const OWNER = "0x00000000000000000000000000000000000000b1";
const pos = (venue: string, marketId: string, side: "long" | "short", liqPx: string, markPx: string) => ({ venue, marketId, canonicalAsset: "EQ:TSLA", side, size: "2", entryPx: "347.00", markPx, notionalUsd: "694.00", leverage: 3, marginMode: "isolated", liqPx, liqPxSource: "venue", marginRatio: "0.12", unrealisedPnlUsd: "1.20", collateralAsset: "USDC", asOf: "2026-11-06T01:00:00.000Z" });

export const VIEW: RiskView = {
  owner: OWNER,
  addresses: [],
  perVenue: [
    { venue: "hyperliquid", identity: { venue: "hyperliquid", owner: OWNER }, equityUsd: "1500.00", freeCollateralUsd: "800.00", positions: [pos("hyperliquid", "hyperliquid:xyz:TSLA", "short", "452.10", "347.60")], asOf: "2026-11-06T01:00:00.000Z" },
    { venue: "lighter-rh", identity: { venue: "lighter-rh", owner: OWNER }, equityUsd: "900.00", freeCollateralUsd: "300.00", positions: [pos("lighter-rh", "lighter-rh:-:TSLA", "long", "251.30", "347.50")], asOf: "2026-11-06T01:00:00.000Z" },
  ],
  exposureByAsset: [{ canonicalAsset: "EQ:TSLA", grossUsd: "1388.00", netUsd: "0.00", legs: ["hyperliquid:xyz:TSLA", "lighter-rh:-:TSLA"] }],
  liquidationLadder: [
    { marketId: "hyperliquid:xyz:TSLA", venue: "hyperliquid", liqPx: "452.10", distancePct: 30.06 },
    { marketId: "lighter-rh:-:TSLA", venue: "lighter-rh", liqPx: "251.30", distancePct: 27.68 },
  ],
  stress: [],
  banner: RISK_BANNER,
  asOf: "2026-11-06T01:00:00.000Z",
} as unknown as RiskView;

/** Words that would present margin or collateral as one pooled figure. */
export const TOTALS = /\b(total|combined|aggregate|overall|net|sum(med)?|pooled|across venues)\b[^.]{0,30}\b(margin|collateral|equity)\b|\b(margin|collateral|equity)\b[^.]{0,15}\b(total|combined|aggregate|overall|sum)\b/i;

