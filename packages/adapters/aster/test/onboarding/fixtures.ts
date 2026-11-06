// Shared onboarding test inputs. Accounts come from public strings (test-only, never funded).
import type { OnboardingStep } from "@capstan/schema";
import { AsterNonce } from "@capstan/signer-aster";
import type { AsterOnboardingCtx, AsterOnboardingRequest } from "../../src/onboarding";
export { testAccount } from "../../../../signers/aster/test/keys";

export const OWNER = "0x77c87137A21b2C13B620415Bbb58ACe24b16755B" as const;
export const AGENT = "0x255b19e79F60e1Ed20076Fe195BF5045f3E016C1" as const;
export const BUILDER = "0xF516fddd46548e304E1bce4DB32FeA7C294E56d2" as const;
export const RELAY_IP = "203.0.113.10";
export const NOW = 1_793_921_875_000;

export const eligibilityStep: OnboardingStep = { kind: "eligibility_declaration", signer: "main_wallet", personalSignText: "eligibility (stub for tests)" };

export function req(over: Partial<AsterOnboardingRequest> = {}): AsterOnboardingRequest {
  return { owner: OWNER, agentAddress: AGENT, mode: "relay", network: "Mainnet", nowMs: NOW, ...over };
}

export function ctx(over: Partial<AsterOnboardingCtx> = {}): AsterOnboardingCtx {
  return { relayEgressIp: RELAY_IP, builder: BUILDER, nonce: new AsterNonce(), eligibilityStep, ...over };
}
