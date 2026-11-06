// Paired funding-spread plan (spec 7.5). Types only. The planner never nets margin across the two legs.
import type { UnsignedVenuePayload, VenueId } from "./adapter";
import type { CanonicalAsset } from "./core";

export const SPREAD_RISK_LABEL = "At-risk. Legging risk is yours." as const;

export type SpreadPlanStatus =
  | "draft"
  | "acked"
  | "leg_a_sent"
  | "leg_a_filled"
  | "leg_b_sent"
  | "complete"
  | "unhedged"
  | "flattened"
  | "failed";

export interface SpreadLeg {
  marketId: string;
  venue: VenueId;
  side: "buy" | "sell";
  size: string;
  collateralAsset: string; // each leg keeps its own venue collateral
  estLiqPx: string | null;
  payloadTemplate: UnsignedVenuePayload;
}

export interface SpreadPlan {
  planId: string;
  canonicalAsset: CanonicalAsset;
  equivalenceId: string; // must be 'approved'
  legA: SpreadLeg; // A = less liquid leg, executed first
  legB: SpreadLeg;
  sizeBase: string;
  residualDeltaBase: string; // after rounding to both lot sizes
  fundingDiffPerHourBps: number; // observed now, annualised shown separately
  roundTripCostBps: number; // fees + builder fees + slippage, open and close, both legs
  breakevenHours: number | null;
  nextSettlements: { venue: VenueId; at: string }[];
  hedgeFailurePolicy: "leave_open" | "flatten_leg_a" | "retry_then_flatten";
  maxLegSlippageBps: number;
  legTimeoutMs: number; // default 3000
  riskLabel: typeof SPREAD_RISK_LABEL;
  ackRequired: true;
  status: SpreadPlanStatus;
}
