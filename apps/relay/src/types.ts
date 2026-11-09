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
  /**
   * The order can rest on the book (a limit order that is not IOC). Missing counts as resting (security r1 R1-06
   * delta: a resting order is in no positions read, so it counts toward the gross cap until a fill shows it done).
   */
  resting?: boolean;
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
  /** The order row that holds this payload hash (a re-run of a stalled relay job reads what the first run recorded). */
  orderByHash(signedPayloadHash: string): Promise<{ id: string; buildId: string; status: string; venueOrderId: string | null } | null>;
  updateOrder(id: string, patch: { status: string; venueOrderId?: string | null }): Promise<void>;
  /**
   * Relay order rows with no venue answer yet (status pending or unknown) submitted between `from` and `to`, oldest
   * first by (submittedAt, id) (security r2 R2-RELAY-03: the pending-order sweep reconciles them). `after` reads the
   * page after that row, so the sweep pages through all of them (gate G-3).
   */
  unsettledOrders(from: Date, to: Date, limit: number, after?: { submittedAt: Date; id: string }): Promise<{ id: string; buildId: string; venue: VenueId; signedPayloadHash: Hex; status: string; venueOrderId: string | null; submittedAt: Date }[]>;
  /** Remove an order row when nothing was sent (lane or budget refusal), so the same payload may be tried again. */
  releaseOrder(id: string): Promise<void>;
  /**
   * The gross notional of the agent's opening orders still pending, accepted or unknown (security r1 R1-06: no daily
   * reset): every one submitted at or after `since.sinceMs`, plus every resting one (limit, not IOC) submitted at or
   * after `since.restingSinceMs`, less the size a fill before `since.sinceMs` shows done. Also today's (UTC) count.
   */
  agentUsage(agentRef: string, nowMs: number, since: GrossSince): Promise<AgentUsage>;
  /**
   * One atomic step per agent (security r1 R1-05): recompute the usage, run `check` on it and insert the pending row,
   * with no other reservation for the same agent in between (a Postgres advisory lock, an in-process lock in memory).
   */
  reserveAgentOrder(row: NewOrderRow, agentRef: string, nowMs: number, since: GrossSince, check: (u: AgentUsage) => ReserveCheck): Promise<ReserveResult>;
}

/** Where the gross cap starts counting orders (see agentUsage). */
export interface GrossSince {
  sinceMs: number;
  restingSinceMs: number;
}

export interface AgentUsage {
  grossNotionalUsd: string;
  ordersToday: number;
}
export type ReserveCheck = { ok: true } | { ok: false; field: string };
export type ReserveResult = { ok: true } | { ok: false; reason: "duplicate" } | { ok: false; reason: "policy"; field: string };

/** Kill view: an in-memory set fed by the Redis subscription; 'unknown' when Redis cannot answer. */
export interface KillView {
  status(agentRef: string): Promise<"killed" | "ok" | "unknown">;
}

export interface PolicySource {
  /** `issuedAtMs`: when the policy was stored; opening orders since then count toward its gross cap. */
  active(agentRef: string, owner: Hex): Promise<{ policyId: string; policy: AgentPolicy; issuedAtMs?: number } | null>;
}

/** The owner's open position notional on one venue from a recent positions read, or null when none is fresh. */
export interface ExposureSource {
  openGrossUsd(owner: Hex, venue: VenueId, nowMs: number): Promise<{ grossUsd: string; asOfMs: number } | null>;
}

export type Lane = "free" | "pro";

export interface LaneDecision {
  ok: boolean;
  lane: Lane;
  reason?: "free_wallet" | "free_ip" | "bot_cap" | "unavailable" | "exit_wallet" | "exit_ip";
}

export interface LaneLimiter {
  take(o: { wallet: string; ipBucket: string; lane: Lane; perMin: number; kind: BuildKind; nowMs: number; venue?: VenueId }): Promise<LaneDecision>;
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
  /**
   * Ask the venue what became of a payload the relay may have sent (the pending-order sweep, R2-RELAY-03). Null when
   * the venue has no keyless read for it or gave no clear answer. Never sends anything.
   */
  lookup?(b: StoredBuild, signedPayloadHash: Hex): Promise<SubmitResult | null>;
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
  /** `key` is the venue budget the job waits on: each key has its own slots. `owner` (the wallet) shares safety places fairly. */
  run<T>(priority: Priority, fn: () => Promise<T>, key?: string, owner?: string): Promise<T>;
}

export interface RelayDeps {
  store: RelayStore;
  kill: KillView;
  policy: PolicySource;
  eligibility: (i: EligibilityInput) => Promise<EligibilityDecision>;
  /** Fresh open positions for the gross cap (security r1 R1-06). Without one, every opening order since the policy was issued counts. */
  exposure?: ExposureSource;
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
  /** How long exit traffic (cancels, closes, reduce-only) may wait for venue budget (default 30 s). */
  safetyBudgetWaitMs?: number;
}

export interface SubmitOutcome {
  order: Order;
  /** null only when the receipt could not be issued yet (receiptPending): the receipt job keeps retrying. */
  receiptId: string | null;
  outcome: SubmitResult["status"];
  receiptPending?: true;
  /** The receipt-sign job id, when the receipt is queued. */
  receiptJob?: string;
}
