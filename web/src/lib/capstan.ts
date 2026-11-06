// The one place the web app reaches into the workspace packages. Browser-safe entry points only: the SDK client,
// the browser key store, the wallet bridge and the receipts verifier. Nothing here builds a venue payload; the SDK
// and the API do that, and the SDK checks every payload before the local key signs.
export { createClient, agentRefFor, type CapstanClient, type CapstanClientOptions, type CheckedBuild, type KillResult, type OnboardResult, type AgentRecord, type Mode } from "../../../packages/sdk/src/client";
export { browserKeyStore } from "../../../packages/sdk/src/keys/browser";
export { memoryKeyStore } from "../../../packages/sdk/src/keys/memory";
export type { KeyStore, KeyStoreOptions } from "../../../packages/sdk/src/keys/types";
export { eip1193Wallet, typedDataDigest, type WalletSigner, type Eip1193Provider } from "../../../packages/sdk/src/wallet";
export { capstanMessage, type SignedPurpose } from "../../../packages/sdk/src/signed-message";
export { describeBundle, checkOnboardingBundle } from "../../../packages/sdk/src/onboard";
export { PINS, mergePins, type Pins, type PinsOverride, type Network } from "../../../packages/sdk/src/pins";
export { rpcAnchorReader, verifyReceiptOffline, type AnchorReader, type ReceiptProof } from "../../../packages/sdk/src/receipts";
export { SPREAD_ACK_TEXT, spreadAckMessage } from "../../../packages/sdk/src/spreads";
export { SdkError } from "../../../packages/sdk/src/errors";
export { verifyFull, type VerifyChecks } from "../../../packages/receipts/src/verify";
export { RISK_BANNER } from "../../../packages/schema/src/core";
export type { AccountSnapshot, FundingSnapshot, Position, QuoteRequest, RiskView, RouteQuote, VenueQuote, OrderIntent, Order } from "../../../packages/schema/src/core";
export type { DelegationState, Hex, OnboardingBundle, OnboardingStep, UnsignedVenuePayload, VenueCapabilities, VenueId } from "../../../packages/schema/src/adapter";
export type { Receipt } from "../../../packages/schema/src/receipt";
export type { SpreadPlan } from "../../../packages/schema/src/spread";
export { SPREAD_RISK_LABEL } from "../../../packages/schema/src/spread";
export type { AgentPolicy } from "../../../packages/schema/src/policy";
export { executeSpreadPlan, type ExecutorEvent } from "../../../packages/sdk/src/spreads";
export { createApi, type Api } from "../../../packages/sdk/src/api";
