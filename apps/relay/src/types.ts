// Relay contracts. The relay never holds a user key and never changes a payload: it checks a client-signed envelope
// against the stored build, re-checks policy and eligibility, dedupes, and forwards the exact signed bytes.
import type { EligibilityDecision, EligibilityInput } from "@capstan/eligibility";
import type { ReceiptDraft } from "@capstan/receipts";
import type { AgentPolicy, Hex, Order, Receipt, SignedEnvelope, SubmitResult, UnsignedVenuePayload, VenueAdapter, VenueId } from "@capstan/schema";
import type { BucketKey, Governor, Priority } from "@capstan/venue-client";

export type BuildKind = "order" | "cancel" | "close";

/** One row of order_builds as the relay reads it. `build` is the adapter's payload exactly as it was returned. */
export interface StoredBuild {
  build: UnsignedVenuePayload;
  owner: Hex;
  agentRef: string | null;
  venue: VenueId;
  marketId: string;
  kind: BuildKind;
  mode: "relay" | "direct";
  requestHash: Hex;
  policyId: string | null;
  leverage: number;
  eligibilityDecisionId: string;
  expiresAt: number; // ms
}

export interface DelegationView {
  id: string; // agentRef
  venue: VenueId;
  owner: Hex;
  agentAddress: Hex | null;
  accountIndex: number | null;
  apiKeyIndex: number | null;
  state: "active" | "retired" | "killed";
  expiresAt: number | null; // ms
}

export interface NewOrderRow {
  id: string;
  buildId: string;
  venue: VenueId;
  marketId: string;
  owner: Hex;
  signedPayloadHash: Hex;
  mode: "relay" | "direct";
  status: string;
  builderFeeBps: number;
  submittedAt: Date;
}

export interface RelayStore {
  getBuild(buildId: string): Promise<StoredBuild | null>;
  getDelegation(agentRef: string): Promise<DelegationView | null>;
  /** INSERT with the unique signed_payload_hash index: false when that payload already exists (dedupe). */
  insertOrder(row: NewOrderRow): Promise<boolean>;
  updateOrder(id: string, patch: { status: string; venueOrderId?: string | null }): Promise<void>;
  /** Remove an order row when nothing was sent (lane or budget refusal), so the same payload may be tried again. */
  releaseOrder(id: string): Promise<void>;
  /** The agent's open gross notional and today's (UTC) order count under its policy. */
  agentUsage(agentRef: string, nowMs: number): Promise<{ grossNotionalUsd: string; ordersToday: number }>;
}

/** Kill view: an in-memory set fed by the Redis subscription; 'unknown' when Redis cannot answer. */
export interface KillView {
  status(agentRef: string): Promise<"killed" | "ok" | "unknown">;
}

export interface PolicySource {
  active(agentRef: string, owner: Hex): Promise<{ policyId: string; policy: AgentPolicy } | null>;
}

export type Lane = "free" | "pro";

export interface LaneDecision {
  ok: boolean;
  lane: Lane;
  reason?: "free_wallet" | "free_ip" | "bot_cap" | "unavailable";
}

export interface LaneLimiter {
  take(o: { wallet: string; ipBucket: string; lane: Lane; perMin: number; kind: BuildKind; nowMs: number }): Promise<LaneDecision>;
}

/** How the relay talks to one executable venue. */
export interface RelayVenue {
  venue: VenueId;
  flag: VenueFlag;
  adapter: Pick<VenueAdapter, "caps" | "verifySigned" | "submit">;
  /** Governor bucket for this venue on this egress IP. */
  governorKey: BucketKey;
  /** Weight of one submit. */
  costOf(env: SignedEnvelope): number;
  /** Lighter: the per-L1 sendTx bucket owner. */
  lighterL1?: (b: StoredBuild) => string;
  /** The payload hash recomputed from the signed body (never the client's claim). */
  payloadHashOf(env: SignedEnvelope, b: StoredBuild): Hex;
  /** Receipt draft for a submit or claim, from the adapter's own draft where it has one. */
  draft(b: StoredBuild, env: SignedEnvelope, result: SubmitResult, payloadHash: Hex): ReceiptDraft;
  /** A venue reply that means "region refused" (spec 10 input 4). None match until a real text is recorded. */
  isGeoError?(result: SubmitResult): boolean;
}

export const VENUE_FLAGS = ["HL_ENABLED", "LIGHTER_304_ENABLED", "LIGHTER_RH_ENABLED", "ASTER_ENABLED"] as const;
export type VenueFlag = (typeof VENUE_FLAGS)[number];

export interface RelayFlags {
  relayEnabled(): boolean;
  venueEnabled(f: VenueFlag): boolean;
  /** RELAY_SUBMIT_ARMED: the relay sends to a venue only when this host was armed (off unless set). */
  submitArmed(): boolean;
}

export interface Dispatcher {
  run<T>(priority: Priority, fn: () => Promise<T>): Promise<T>;
}

export interface RelayDeps {
  store: RelayStore;
  kill: KillView;
  policy: PolicySource;
  eligibility: (i: EligibilityInput) => Promise<EligibilityDecision>;
  /** Venue-signal refusals cached per owner and venue (24 h). */
  venueSignals: { get(owner: Hex, venue: VenueId, nowMs: number): Promise<boolean>; put(owner: Hex, venue: VenueId, nowMs: number): Promise<void> };
  lanes: LaneLimiter;
  /** The caller's relay lane and per-minute wallet limit (tiers, todo 34). */
  laneOf(owner: Hex, apiKeyId?: string): Promise<{ lane: Lane; perMin: number }>;
  governor: Governor;
  venues: Map<VenueId, RelayVenue>;
  receipts: { issue(d: ReceiptDraft): Promise<Receipt> };
  flags: RelayFlags;
  alerts: { policyBreach(e: { owner: Hex; agentRef: string; field: string; buildId: string }): Promise<void> };
  dispatch: Dispatcher;
  now: () => number;
  id: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
  /** How long a free-lane submit may wait for venue budget before VENUE_RATE_LIMITED. */
  freeBudgetWaitMs?: number;
  proBudgetWaitMs?: number;
}

export interface SubmitOutcome {
  order: Order;
  receiptId: string;
  outcome: SubmitResult["status"];
}
