// Onboarding step builders and the template hash. The SDK pins `templateHash` per release and refuses a bundle whose
// SHAPE it does not know: values the user supplies (addresses, names, nonces, amounts) become type tags, while the
// fields that make the approval what it is (step kinds and order, signer, typed-data types, domain name, maxFeeRate,
// source dex) stay literal.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import { CapstanError, type Hex, type OnboardingBundle, type OnboardingStep, type TypedDataPayload } from "@capstan/schema";
import { postedUserAction, toHex, userSignedTypedData, type HlNetwork, type HlUserAction } from "@capstan/signer-hl";

export const HL_TEMPLATE_VERSION = 1;
/** Message fields kept literal in the template hash. */
export const PINNED_FIELDS = new Set(["maxFeeRate", "sourceDex", "fromSubAccount", "hyperliquidChain"]);

function tag(v: unknown): string {
  if (v === null) return "<null>";
  if (typeof v === "string") return /^0x[0-9a-fA-F]{40}$/.test(v) ? "<address>" : /^0x[0-9a-fA-F]*$/.test(v) ? "<hex>" : "<string>";
  if (typeof v === "number" || typeof v === "bigint") return "<number>";
  if (typeof v === "boolean") return "<bool>";
  if (Array.isArray(v)) return "<array>";
  return "<object>";
}

function typedShape(td: TypedDataPayload | undefined): unknown {
  if (!td) return null;
  const message: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(td.message)) message[k] = PINNED_FIELDS.has(k) ? v : tag(v);
  return {
    primaryType: td.primaryType,
    types: td.types,
    domain: { name: td.domain.name ?? null, version: td.domain.version ?? null, chainId: tag(td.domain.chainId ?? null), verifyingContract: td.domain.verifyingContract ?? null },
    message,
  };
}

export function bundleShape(bundle: Pick<OnboardingBundle, "venue" | "steps">): unknown {
  return {
    v: HL_TEMPLATE_VERSION,
    venue: bundle.venue,
    steps: bundle.steps.map((s) => ({ kind: s.kind, signer: s.signer, typedData: typedShape(s.typedData), personalSignText: s.personalSignText === undefined ? null : "<string>", venueTx: s.venueTx === undefined ? null : "<object>" })),
  };
}

/** keccak256 of the RFC 8785 JCS of the bundle shape. */
export function templateHash(bundle: Pick<OnboardingBundle, "venue" | "steps">): Hex {
  const s = canonicalize(bundleShape(bundle));
  if (s === undefined) throw new CapstanError("INTERNAL_ERROR", "templateHash: bundle is not JSON");
  return toHex(keccak_256(utf8ToBytes(s)));
}

export interface UserStepInput {
  network: HlNetwork;
  signatureChainId: Hex;
  nonce: number;
}

/** A main-wallet step: the typed data to sign plus the unsigned posted action (venueTx). */
export function userStep(kind: OnboardingStep["kind"], a: HlUserAction): OnboardingStep {
  return { kind, signer: "main_wallet", typedData: userSignedTypedData(a), venueTx: { action: postedUserAction(a), nonce: a.nonce } };
}

export function approveAgentStep(i: UserStepInput & { agentAddress: Hex; agentName: string }, kind: OnboardingStep["kind"] = "hl_approve_agent"): OnboardingStep {
  return userStep(kind, { type: "approveAgent", hyperliquidChain: i.network, signatureChainId: i.signatureChainId, agentAddress: i.agentAddress.toLowerCase() as Hex, agentName: i.agentName, nonce: i.nonce });
}

export function approveBuilderFeeStep(i: UserStepInput & { builder: Hex; maxFeeRate: `${string}%` }, kind: OnboardingStep["kind"] = "hl_approve_builder_fee"): OnboardingStep {
  return userStep(kind, { type: "approveBuilderFee", hyperliquidChain: i.network, signatureChainId: i.signatureChainId, maxFeeRate: i.maxFeeRate, builder: i.builder.toLowerCase() as Hex, nonce: i.nonce });
}

export function collateralMoveStep(i: UserStepInput & { owner: Hex; toDex: string; token: string; amount: string }): OnboardingStep {
  return userStep("hl_collateral_move", {
    type: "sendAsset",
    hyperliquidChain: i.network,
    signatureChainId: i.signatureChainId,
    destination: i.owner.toLowerCase() as Hex,
    sourceDex: "",
    destinationDex: i.toDex,
    token: i.token,
    amount: i.amount,
    fromSubAccount: "",
    nonce: i.nonce,
  });
}
