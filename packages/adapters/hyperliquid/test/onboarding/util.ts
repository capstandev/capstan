// Shared fixtures for the onboarding tests: keys from public seed strings, a stub declaration step, signing helpers.
import type { Hex, OnboardingBundle, OnboardingStep, SignedOnboarding } from "@capstan/schema";
import { addressOf, hashTypedPayload, padRs, signDigest } from "@capstan/signer-hl";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { HlOnboardingContext, HlOnboardingRequest } from "../../src";
import { BUILDER, fixtureReader } from "../helpers";

export const key = (label: string) => keccak_256(utf8ToBytes(`capstan-hl-onboarding-test:${label}`)); // test-key
export const OWNER_KEY = key("owner");
export const AGENT_KEY = key("agent");
export const OWNER = addressOf(OWNER_KEY).toLowerCase() as Hex;
export const AGENT = addressOf(AGENT_KEY).toLowerCase() as Hex;
export const NOW = 1793934060000;
export const DAY = 86_400_000;

export const stubDeclaration = (): OnboardingStep => ({ kind: "eligibility_declaration", signer: "main_wallet", personalSignText: "Capstan eligibility declaration (test stub)" });

export function request(over: Partial<HlOnboardingRequest> = {}): HlOnboardingRequest {
  return { venue: "hyperliquid", owner: OWNER, agentAddress: AGENT, builderMaxBps: 3, network: "Mainnet", signatureChainId: "0xa4b1", agentValidUntilMs: NOW + 90 * DAY, ...over };
}

export function context(override?: (b: Record<string, any>) => unknown, over: Partial<HlOnboardingContext> = {}) {
  const fr = fixtureReader(override);
  const ctx: HlOnboardingContext = { reader: fr.reader, builder: BUILDER, nowMs: NOW, declarationStep: stubDeclaration, ...over };
  return { ...fr, ctx };
}

export function sigHex(digest: Hex, sk: Uint8Array): Hex {
  const s = padRs(signDigest(digest, sk));
  return `0x${s.r.slice(2)}${s.s.slice(2)}${s.v.toString(16)}` as Hex;
}

/** Sign every typed-data step with `sk` (or `pick(stepIndex)`); the declaration gets a placeholder. */
export function signAll(bundle: OnboardingBundle, pick: (i: number, s: OnboardingStep) => Uint8Array = () => OWNER_KEY): SignedOnboarding {
  return {
    bundleId: bundle.bundleId,
    signatures: bundle.steps.map((s, i) => ({ step: i, sig: s.typedData ? sigHex(hashTypedPayload(s.typedData), pick(i, s)) : ("0x" as Hex) })),
  };
}
