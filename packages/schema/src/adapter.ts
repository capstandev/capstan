// Canonical venue adapter contract (spec section 2) plus every type it names. Types only, plus the zod enum for
// venue ids. Every adapter package implements `VenueAdapter`; nothing here performs I/O.
import { z } from "zod";
import type {
  AccountSnapshot,
  FundingSnapshot,
  Market,
  Order,
  OrderBook,
  OrderIntent,
  QuoteRequest,
  VenueQuote,
} from "./core";

export const VENUE_IDS = [
  "hyperliquid", // core + every HIP-3 dex, told apart by Market.dex
  "lighter-mainnet", // signing ID 304
  "lighter-rh", // signing ID 466324
  "aster",
  "variational", // read-only
  "arcus", // read-only
] as const;

export type VenueId = (typeof VENUE_IDS)[number];
export const VenueIdSchema = z.enum(VENUE_IDS);

export type KeyType = "secp256k1" | "lighter-native" | "ed25519" | "stark" | "cosmos";
export type Delegation = "agent" | "api_key_index" | "subkey" | "permissioned_key" | "session_key" | "none";
export type Hex = `0x${string}`;

export interface BuilderFeeRail {
  // 'lighter_integrator' added from venue research: Lighter has an integrator rail (ApproveIntegrator, tx 45) with caps
  // of 10 bps on 304 perps and 100 bps on 466324 perps. Capstan launches with chargeBps 0 there.
  kind: "hl_builder_code" | "aster_code" | "lighter_integrator";
  // HL f in tenths of a bp; Aster decimal (0.0002 = 2 bps); Lighter integrator fee in parts per million.
  unit: "tenths_bp" | "decimal_rate" | "ppm";
  capBps: number; // venue-enforced ceiling: HL 10, Aster 10, Lighter 10 (304) and 100 (466324)
  chargeBps?: number; // what Capstan charges by default (Lighter: 0)
  approvalSignedBy: "main_wallet"; // never the delegated key
  builderAddress: Hex; // brand-only builder wallet for this venue
}

export interface VenueCapabilities {
  venue: VenueId;
  execution: boolean; // false for variational, arcus
  keyType: KeyType | null;
  delegation: Delegation;
  canWithdraw: false; // invariant 2: a type-level literal, no adapter may declare true
  builderFee: BuilderFeeRail | null; // Lighter uses the 'lighter_integrator' rail with chargeBps 0
  collateral: string[]; // ['USDC'] | ['USDG', 'STOCK_TOKENS'] | ...
  directSubmitSupported: boolean;
  publicAccountReads: boolean; // HL true, Lighter true, Aster false
  signingDomain?: { chainId: number; name?: string }; // Lighter 304 / 466324
}

export interface VenueIdentity {
  venue: VenueId;
  owner: Hex; // main wallet address (HL master, Aster user, Lighter L1); public
  accountIndex?: number; // Lighter
  agentAddress?: Hex; // public address of the delegated key (HL agent, Aster signer)
  apiKeyIndex?: number; // Lighter 4-156 | 158-254
}

/** EIP-712 typed data as signed by a wallet (eth_signTypedData_v4 shape). Amounts are strings or bigint, never floats. */
export interface TypedDataPayload {
  domain: { name?: string; version?: string; chainId?: number | string; verifyingContract?: Hex; salt?: Hex };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Quote request for one market on one venue (the route quote fans a QuoteRequest out into these). */
export interface VenueQuoteRequest extends Omit<QuoteRequest, "canonicalAsset" | "marketIds"> {
  marketId: string;
  feeTier?: string; // owner's venue fee tier when known, else the venue's base tier
}

export interface OnboardingRequest {
  venue: VenueId;
  owner: Hex;
  agentAddress?: Hex; // HL agent / Aster signer, public part only
  lighterPubKey?: string; // Lighter API public key, generated client-side
  builderMaxBps?: number; // approval ceiling the owner signs (HL "0.03%" = 3 bps)
  policy?: unknown; // optional AgentPolicy to sign in the same ceremony
  accountIndex?: number;
  apiKeyIndex?: number;
  expiresAt?: number; // ms; agent expiry where the venue supports it
}

export type OnboardingStepKind =
  | "eligibility_declaration"
  | "hl_approve_agent"
  | "hl_approve_builder_fee"
  | "hl_collateral_move"
  | "aster_approve_agent"
  | "aster_approve_builder"
  | "lighter_change_pubkey"
  | "lighter_approve_integrator"
  | "agent_policy"
  | "revoke_agent"
  | "revoke_builder";

export interface OnboardingStep {
  kind: OnboardingStepKind;
  signer: "main_wallet" | "delegated_key";
  typedData?: TypedDataPayload;
  personalSignText?: string;
  venueTx?: unknown;
}

export interface OnboardingBundle {
  bundleId: string;
  venue: VenueId;
  owner: Hex;
  steps: OnboardingStep[];
  humanReadable: string[]; // one plain sentence per step, shown before the wallet prompt
  templateHash: Hex; // published per SDK release; the SDK refuses an unknown template
  expiresAt: number; // ms
}

export interface SignedOnboarding {
  bundleId: string;
  signatures: { step: number; sig: Hex }[];
  lighterSignedTx?: unknown;
}

export interface DelegationState {
  agentActive: boolean;
  builderMaxBps: number | null;
  expiresAt?: string;
  policyId?: string;
  routing: "ok" | "fee_free_unavailable";
}

export interface OnboardingResult {
  agentRef: string;
  delegation: DelegationState;
  venueResponses: unknown[];
  receiptId?: string;
}

export interface BuildContext {
  owner: Hex;
  agentRef: string;
  identity: VenueIdentity;
  builderFee: { tenthsBp?: number; decimalRate?: string; ppm?: number } | null;
  approvedMaxBps: number | null;
  nowMs: number;
  eligibilityDecisionId: string;
  policyId: string | null;
}

export interface CancelIntent {
  marketId: string;
  venueOrderId?: string;
  clientOrderId?: string;
}

/** What the build shows the user before signing. Fees are in bps; amounts are decimal strings. */
export interface OrderPreview {
  marketId: string;
  side: "buy" | "sell";
  size: string;
  px: string | null; // limit price, or the protective price for a market order
  notionalUsd: string;
  venueFeeBps: number;
  builderFeeBps: number;
  builderFee: { address: Hex; rawUnit: string } | null; // raw venue value, e.g. HL f=20 or Aster 0.0002
  slippageBps: number;
  estLiqPx: string | null;
  collateralAsset: string;
  reduceOnly: boolean;
  warnings: string[];
}

export interface UnsignedVenuePayload {
  buildId: string; // ulid
  venue: VenueId;
  signer: "delegated_key";
  encoding: "hl_l1_action" | "lighter_tx" | "aster_v3_params";
  payload: unknown; // venue-native object to sign
  digest: Hex; // what the key signs (where computable server-side)
  preview: OrderPreview;
  expiresAt: number; // build valid 30 s
  eligibilityDecisionId: string;
}

export interface SignedEnvelope {
  buildId: string;
  venue: VenueId;
  encoding: UnsignedVenuePayload["encoding"];
  signedBody: unknown;
  signature: Hex | string;
  signerRef: string; // agent address or Lighter account:key index (public)
  payloadHash: Hex;
}

export type VerifyResult = { ok: true } | { ok: false; code: "PAYLOAD_MISMATCH" | "BUILD_EXPIRED" | "BAD_SIGNATURE" | "RETIRED_AGENT" | "AGENT_KILLED"; field?: string };

export interface SubmitResult {
  // 'unknown': the venue gave no clear answer (Aster 503, Lighter "code 200" without a hash). Never retried blindly.
  status: "accepted" | "rejected" | "unknown";
  venueOrderId: string | null; // venue ids are strings end to end (never numbers above 2^53 - 1)
  txHash: string | null;
  venueResponse: unknown; // raw, so the adapter and receipt can hash it
  code?: string;
  message?: string;
}

/** A read the client signed with its own key (Aster account reads), forwarded for ingest. */
export interface SignedRead {
  venue: VenueId;
  owner: Hex;
  signerRef: string;
  request: { method: "GET" | "POST"; path: string; query: string };
  signature: Hex | string;
  issuedAt: number;
  expiresAt: number;
}

export type MarketEvent =
  | { kind: "book"; book: OrderBook }
  | { kind: "mark"; marketId: string; mark: string; index?: string; asOf: string }
  | { kind: "funding"; funding: FundingSnapshot }
  | { kind: "trade"; marketId: string; px: string; sz: string; side: "buy" | "sell"; ts: string; tradeId: string };

export type Unsubscribe = () => void;

export interface BuilderFeeRow {
  day: string; // YYYY-MM-DD (UTC)
  venue: VenueId;
  builder: Hex;
  owner: Hex | null;
  venueOrderId: string | null; // HL CSV has none; userFills has oid
  marketId: string | null;
  notionalUsd: string;
  feeUsd: string;
  ts: string;
  source: "hl_user_fills" | "hl_csv" | "aster_ledger";
}

export interface VenueAdapter {
  readonly caps: VenueCapabilities;

  // Reads (keyless where the venue allows)
  listMarkets(): Promise<Market[]>;
  getBook(marketId: string, depth?: number): Promise<OrderBook>;
  getFunding(marketId: string): Promise<FundingSnapshot>;
  getAccount(id: VenueIdentity, clientSignedRead?: SignedRead): Promise<AccountSnapshot>;
  getOpenOrders(id: VenueIdentity, clientSignedRead?: SignedRead): Promise<Order[]>;
  streamMarket(marketIds: string[], onEvent: (e: MarketEvent) => void): Unsubscribe;

  // Quote (pure function of cached book + fee schedule + funding)
  quote(req: VenueQuoteRequest): Promise<VenueQuote>;

  // Onboarding: payloads the MAIN WALLET signs (approveAgent / builder approval / key registration)
  buildOnboarding(req: OnboardingRequest): Promise<OnboardingBundle>;
  submitOnboarding(signed: SignedOnboarding): Promise<OnboardingResult>;
  verifyOnboarding(id: VenueIdentity): Promise<DelegationState>;

  // Trading: payloads the DELEGATED KEY signs client-side
  buildOrder(intent: OrderIntent, ctx: BuildContext): Promise<UnsignedVenuePayload>;
  buildCancel(req: CancelIntent, ctx: BuildContext): Promise<UnsignedVenuePayload>;
  verifySigned(env: SignedEnvelope, build: UnsignedVenuePayload): VerifyResult; // hash + field match
  submit(env: SignedEnvelope): Promise<SubmitResult>;

  // Revocation payloads for the owner (kill switch)
  buildRevocation(id: VenueIdentity): Promise<OnboardingBundle>;

  // Builder-fee reconciliation (venues with a rail)
  reconcileBuilderFees?(day: string): Promise<BuilderFeeRow[]>;
}
