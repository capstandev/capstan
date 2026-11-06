// @capstan/sdk: the client side of Capstan. Delegated trade-only keys are generated and held here (and only here);
// every server payload is checked against the user's intent and this release's pins before the local key signs.
// No export accepts a main-wallet key: the main wallet is reached through WalletSigner only.
export const PACKAGE_NAME = "@capstan/sdk" as const;

export { createClient, agentRefFor, type CapstanClient, type CapstanClientOptions, type CheckedBuild, type KillResult, type OnboardResult, type AgentRecord, type Mode } from "./client";
export { checkBuild, checkCancelBuild, DEFAULT_REF_TOL_BPS, MAX_BUILD_LIFE_MS, type CheckContext, type CheckResult, type CheckIdentity } from "./check";
export { checkOnboardingBundle, describeBundle, hlTemplateHash, lighterTemplateHash, asterTemplateHash, changePubKeyMessage, type BundleCheck, type BundleCheckContext } from "./onboard";
export { PINS, mergePins, assertServerMatchesPins, pinnedBuilder, type Pins, type NetworkPins, type PinsOverride, type Network } from "./pins";
export { checkPolicy, type PolicyCheckInput, type PolicyCheckResult, type PolicyChecker } from "./policy";
export { memoryKeyStore } from "./keys/memory";
export { fileKeyStore, MIN_PASSPHRASE, SCRYPT_N } from "./keys/file";
export { browserKeyStore, type BrowserKeyStoreOptions } from "./keys/browser";
export type { KeyStore, KeyInfo, KeyStoreOptions, LighterSignRequest, LighterSignResult, LighterSignerFactory } from "./keys/types";
export { eip1193Wallet, accountWallet, typedDataDigest, type WalletSigner, type Eip1193Provider, type AccountLike } from "./wallet";
export { publicVenueMarkets, staticMarketSource, parseMarketId, hlAssetId, type MarketSource, type VenueMarketSpec } from "./markets";
export { verifyReceiptOffline, rpcAnchorReader, type AnchorReader, type ReceiptProof, type VerifyChecks } from "./receipts";
export { sdkSpendControls, selectPayment, payingFetch, usdToAtomic, X402_NETWORKS, type SpendControls, type X402Payer, type PaymentRequired, type PaymentRequirements } from "./x402";
export { capstanMessage, type CapstanMessageFields, type SignedPurpose } from "./signed-message";
export { defaultStepPresenter, resolvePresenter, stepsText, STEPS_HEADING, type StepPresenter } from "./present";
export { intentFromPayload } from "./intent";
export { SdkError, SDK_ERROR_CODES, type SdkErrorCode } from "./errors";
export { clientSpreadPorts, executeSpread, executeSpreadPlan, spreadAckMessage, SPREAD_ACK_TEXT, type ExecuteResult, type ExecutorEvent, type ExecutorPorts, type SpreadPortOptions } from "./spreads";
