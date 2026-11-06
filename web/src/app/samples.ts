// Sample data for the static render checks (copy rules, AI-tell lint, accessibility). Never used by the running app.
import { RISK_BANNER, type RiskView, type RouteQuote } from "../lib/capstan";

const OWNER = "0x00000000000000000000000000000000000000b1";
const asOf = "2026-11-06T01:00:00.000Z";

export const SAMPLE_QUOTE = {
  requestId: "sample",
  legs: [
    { marketId: "hyperliquid:xyz:TSLA", venue: "hyperliquid", status: "ok", avgFillPx: "347.70", slippageBps: 1.5, venueFeeBps: 4.5, builderFeeBps: 2, fundingCostBps: 24, totalCostBps: 32, estLiqPx: "452.10", collateralAsset: "USDC", asOf, staleMs: 200 },
    { marketId: "lighter-rh:-:TSLA", venue: "lighter-rh", status: "refused", refusal: { code: "GEO_REFUSED", reason: "Not available in your region." }, avgFillPx: "0", slippageBps: 0, venueFeeBps: 0, builderFeeBps: 0, fundingCostBps: 0, totalCostBps: 0, estLiqPx: null, collateralAsset: "USDG", asOf, staleMs: 0 },
    { marketId: "variational:-:TSLA", venue: "variational", status: "data_only", avgFillPx: "347.60", slippageBps: 0.5, venueFeeBps: 0, builderFeeBps: 0, fundingCostBps: 20, totalCostBps: 20, estLiqPx: null, collateralAsset: "USDC", asOf, staleMs: 9000 },
  ],
  best: "hyperliquid:xyz:TSLA",
  ranking: ["hyperliquid:xyz:TSLA"],
  receiptHint: "",
} as unknown as RouteQuote;

export const SAMPLE_RISK = {
  owner: OWNER,
  addresses: [],
  perVenue: [
    { venue: "hyperliquid", identity: { venue: "hyperliquid", owner: OWNER }, equityUsd: "1500.00", freeCollateralUsd: "800.00", positions: [{ venue: "hyperliquid", marketId: "hyperliquid:xyz:TSLA", canonicalAsset: "EQ:TSLA", side: "short", size: "2", entryPx: "347.00", markPx: "347.60", notionalUsd: "694.00", leverage: 3, marginMode: "isolated", liqPx: "452.10", liqPxSource: "venue", marginRatio: "0.12", unrealisedPnlUsd: "1.20", collateralAsset: "USDC", asOf }], asOf },
    { venue: "aster", identity: { venue: "aster", owner: OWNER }, equityUsd: "400.00", freeCollateralUsd: "400.00", positions: [], asOf },
  ],
  exposureByAsset: [],
  liquidationLadder: [{ marketId: "hyperliquid:xyz:TSLA", venue: "hyperliquid", liqPx: "452.10", distancePct: 30.06 }],
  stress: [],
  banner: RISK_BANNER,
  asOf,
} as unknown as RiskView;
