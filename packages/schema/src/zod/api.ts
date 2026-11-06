// One zod schema per API input in spec 13.1. No schema here has a field named like a key (privateKey, secret, seed,
// mnemonic, apiSecret): packages/schema/test/zod.test.ts walks every shape to prove it.
import { z } from "zod";
import {
  AddressZ,
  CanonicalAssetZ,
  CsvVenuesZ,
  DecimalZ,
  HexZ,
  IsoTimeZ,
  MarketIdZ,
  ModeZ,
  PositiveDecimalZ,
  SideZ,
  SigZ,
  UlidZ,
  VenueZ,
} from "./common";

const boolQ = z.enum(["true", "false"]).transform((v) => v === "true");

// GET /markets?venue=&dex=&asset=&executable=
export const MarketsQueryZ = z.object({
  venue: VenueZ.optional(),
  dex: z.string().max(20).optional(),
  asset: CanonicalAssetZ.optional(),
  executable: boolQ.optional(),
});
// GET /markets/{id}/book?depth=20
export const BookQueryZ = z.object({ id: MarketIdZ, depth: z.coerce.number().int().min(1).max(100).default(20) });
// GET /funding?asset= and GET /funding/forecast?asset=
export const FundingQueryZ = z.object({ asset: CanonicalAssetZ });
export const FundingForecastQueryZ = z.object({ asset: CanonicalAssetZ });

// POST /quote (also GET /quote?...)
export const QuoteRequestZ = z
  .object({
    canonicalAsset: CanonicalAssetZ.optional(),
    marketIds: z.array(MarketIdZ).min(1).max(20).optional(),
    side: SideZ,
    sizeBase: PositiveDecimalZ.optional(),
    notionalUsd: PositiveDecimalZ.optional(),
    leverage: z.number().min(1).max(100),
    holdHours: z.number().min(0).max(24 * 365),
    orderType: z.enum(["market", "limit"]),
    limitPx: PositiveDecimalZ.optional(),
    owner: AddressZ.optional(),
  })
  .refine((q) => q.canonicalAsset !== undefined || q.marketIds !== undefined, "canonicalAsset or marketIds is required")
  .refine((q) => (q.sizeBase === undefined) !== (q.notionalUsd === undefined), "exactly one of sizeBase or notionalUsd")
  .refine((q) => q.orderType === "market" || q.limitPx !== undefined, "limitPx is required for a limit order");

// GET /onboarding/preflight?venue=&owner=
export const OnboardingPreflightQueryZ = z.object({ venue: VenueZ, owner: AddressZ });
// POST /onboarding/build
export const OnboardingBuildZ = z
  .object({
    venue: VenueZ,
    owner: AddressZ,
    agentAddress: AddressZ.optional(),
    lighterPubKey: HexZ.optional(),
    builderMaxBps: z.number().min(0).max(10).optional(),
    policy: z.unknown().optional(),
  })
  .refine((b) => (b.agentAddress === undefined) !== (b.lighterPubKey === undefined), "exactly one of agentAddress or lighterPubKey");
// POST /onboarding/submit
export const OnboardingSubmitZ = z.object({
  bundleId: z.string().min(1).max(64),
  signatures: z.array(z.object({ step: z.number().int().min(0).max(20), sig: SigZ })).min(1).max(20),
  lighterSignedTx: z.unknown().optional(),
});

// OrderIntent (spec 3)
export const OrderIntentZ = z
  .object({
    marketId: MarketIdZ,
    side: SideZ,
    size: PositiveDecimalZ,
    type: z.enum(["market", "limit"]),
    limitPx: PositiveDecimalZ.optional(),
    tif: z.enum(["ioc", "gtc", "alo"]),
    reduceOnly: z.boolean(),
    leverage: z.number().min(1).max(100).optional(),
    clientOrderId: z.string().min(1).max(64).optional(),
    maxSlippageBps: z.number().int().min(0).max(5000),
  })
  .refine((i) => i.type === "market" || i.limitPx !== undefined, "limitPx is required for a limit order");

// POST /orders/build
export const OrderBuildZ = z.object({ owner: AddressZ, agentRef: z.string().min(1).max(64), intent: OrderIntentZ, mode: ModeZ });

export const SignedEnvelopeZ = z.object({
  buildId: UlidZ,
  venue: VenueZ,
  encoding: z.enum(["hl_l1_action", "lighter_tx", "aster_v3_params"]),
  signedBody: z.unknown(),
  signature: z.string().min(2).max(2048),
  signerRef: z.string().min(1).max(128),
  payloadHash: HexZ,
});
// POST /orders/submit
export const OrderSubmitZ = z.object({ buildId: UlidZ, signedEnvelope: SignedEnvelopeZ });
// POST /orders/cancel/build
export const CancelBuildZ = z
  .object({
    owner: AddressZ,
    agentRef: z.string().min(1).max(64),
    marketId: MarketIdZ.optional(),
    venueOrderId: z.string().min(1).max(80).optional(),
    clientOrderId: z.string().min(1).max(64).optional(),
  })
  .refine((c) => c.venueOrderId !== undefined || c.clientOrderId !== undefined, "venueOrderId or clientOrderId is required");
// POST /orders/close-all/build
export const CloseAllBuildZ = z.object({ owner: AddressZ, venues: z.array(VenueZ).optional() });
// POST /receipts/claim
export const ReceiptClaimZ = z.object({ buildId: UlidZ, signedEnvelope: SignedEnvelopeZ, venueResponse: z.unknown() });

// GET /positions?owner=&venues=
export const PositionsQueryZ = z.object({ owner: AddressZ, venues: CsvVenuesZ.optional() });
// POST /risk/ingest
export const RiskIngestZ = z.object({
  venue: z.literal("aster"),
  snapshot: z.unknown(),
  signedRead: z.object({
    venue: VenueZ,
    owner: AddressZ,
    signerRef: z.string().min(1).max(128),
    request: z.object({ method: z.enum(["GET", "POST"]), path: z.string().max(200), query: z.string().max(4096) }),
    signature: z.string().min(2).max(512),
    issuedAt: z.number().int(),
    expiresAt: z.number().int(),
  }),
});
// GET /risk?owner=
export const RiskQueryZ = z.object({ owner: AddressZ });
const VenueIdentityZ = z.object({
  venue: VenueZ,
  owner: AddressZ,
  accountIndex: z.number().int().min(0).optional(),
  agentAddress: AddressZ.optional(),
  apiKeyIndex: z.number().int().min(0).max(255).optional(),
});
// POST /risk/snapshot
export const RiskSnapshotZ = z.object({ addresses: z.array(VenueIdentityZ).min(1).max(20) });
// GET /risk/liq-heatmap?asset=
export const LiqHeatmapQueryZ = z.object({ asset: CanonicalAssetZ });

// GET /spreads/scan?asset=&minHours=
export const SpreadScanQueryZ = z.object({ asset: CanonicalAssetZ.optional(), minHours: z.coerce.number().min(0).max(24 * 365).optional() });
// POST /spreads/plan
export const SpreadPlanZ = z.object({
  owner: AddressZ,
  equivalenceId: z.string().min(1).max(64),
  sizeBase: PositiveDecimalZ,
  leverage: z.number().min(1).max(100),
  hedgeFailurePolicy: z.enum(["leave_open", "flatten_leg_a", "retry_then_flatten"]),
});
// POST /spreads/{id}/ack
export const SpreadAckZ = z.object({ sig: SigZ });
// POST /spreads/{id}/events
export const SpreadEventZ = z.object({ kind: z.string().min(1).max(40), data: z.unknown(), signedPayloadHash: HexZ.optional() });

// POST /agents/policy
export const AgentPolicyZ = z.object({
  owner: AddressZ,
  agents: z.array(z.object({ venue: VenueZ, agentRef: z.string().min(1).max(64) })).min(1).max(20),
  maxNotionalPerOrderUsd: PositiveDecimalZ,
  maxGrossNotionalUsd: PositiveDecimalZ,
  maxLeverage: z.number().min(1).max(100),
  allowedMarkets: z.union([z.literal("*"), z.array(MarketIdZ).max(500)]),
  allowedVenues: z.array(VenueZ).min(1),
  maxOrdersPerDay: z.number().int().min(0).max(1_000_000),
  reduceOnlyAfter: IsoTimeZ.optional(),
  expiresAt: IsoTimeZ,
  nonce: z.string().min(1).max(80),
});
export const AgentPolicySubmitZ = z.object({ policy: AgentPolicyZ, ownerSig: SigZ });
// POST /agents/{agentRef}/kill
export const AgentKillZ = z.object({ sig: SigZ, message: z.string().min(1).max(2000), closeAll: z.boolean().optional() });

// GET /receipts/{id}
export const ReceiptIdZ = z.object({ id: UlidZ });
// GET /history/funding?marketId=&from=&to=
export const HistoryFundingQueryZ = z.object({ marketId: MarketIdZ, from: IsoTimeZ, to: IsoTimeZ });
// GET /eligibility?venue=
export const EligibilityQueryZ = z.object({ venue: VenueZ.optional() });

// Everything above, by route, for tests and the route table.
export const API_INPUT_SCHEMAS = {
  "GET /markets": MarketsQueryZ,
  "GET /markets/{id}/book": BookQueryZ,
  "GET /funding": FundingQueryZ,
  "GET /funding/forecast": FundingForecastQueryZ,
  "POST /quote": QuoteRequestZ,
  "GET /onboarding/preflight": OnboardingPreflightQueryZ,
  "POST /onboarding/build": OnboardingBuildZ,
  "POST /onboarding/submit": OnboardingSubmitZ,
  "POST /orders/build": OrderBuildZ,
  "POST /orders/submit": OrderSubmitZ,
  "POST /orders/cancel/build": CancelBuildZ,
  "POST /orders/close-all/build": CloseAllBuildZ,
  "POST /receipts/claim": ReceiptClaimZ,
  "GET /positions": PositionsQueryZ,
  "POST /risk/ingest": RiskIngestZ,
  "GET /risk": RiskQueryZ,
  "POST /risk/snapshot": RiskSnapshotZ,
  "GET /risk/liq-heatmap": LiqHeatmapQueryZ,
  "GET /spreads/scan": SpreadScanQueryZ,
  "POST /spreads/plan": SpreadPlanZ,
  "POST /spreads/{id}/ack": SpreadAckZ,
  "POST /spreads/{id}/events": SpreadEventZ,
  "POST /agents/policy": AgentPolicySubmitZ,
  "POST /agents/{agentRef}/kill": AgentKillZ,
  "GET /receipts/{id}": ReceiptIdZ,
  "GET /history/funding": HistoryFundingQueryZ,
  "GET /eligibility": EligibilityQueryZ,
} as const;
