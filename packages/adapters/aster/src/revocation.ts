// Revocation (kill switch, spec 7.2 and 7.4): the MAIN wallet signs DelAgent and DelBuilder (Mode A, chain id 56).
// Sent as DELETE /fapi/v3/agent and DELETE /fapi/v3/builder (submit lives in submitRevocation, todo 15).
// Field lists follow the venue's delete demos (VERIFY on testnet, BACKLOG A4).
import { ulid } from "@capstan/core";
import { CapstanError, type Hex, type OnboardingBundle } from "@capstan/schema";
import type { AsterNonce } from "@capstan/signer-aster";
import type { AsterNetwork } from "./config";
import { ASTER_BUNDLE_TTL_MS, mgmtStep, onboardingTemplateHash, type AsterVenueTx } from "./onboarding";

export interface AsterRevocationCtx {
  builder: Hex;
  nonce: AsterNonce; // the owner's nonce state
  network: AsterNetwork;
  nowMs: number;
  serverTimeMs?: number;
}

function nonceOf(ctx: AsterRevocationCtx): number {
  const v = ctx.nonce.next(BigInt(ctx.nowMs) * 1000n, ctx.serverTimeMs === undefined ? undefined : BigInt(ctx.serverTimeMs) * 1000n);
  return Number(v);
}

export function delAgentTx(owner: Hex, agent: Hex, network: AsterNetwork, nonce: number): AsterVenueTx {
  return { method: "DELETE", path: "/fapi/v3/agent", primaryType: "DelAgent", params: [["agentAddress", agent], ["asterChain", network], ["user", owner], ["nonce", nonce]] };
}

export function delBuilderTx(owner: Hex, builder: Hex, network: AsterNetwork, nonce: number): AsterVenueTx {
  return { method: "DELETE", path: "/fapi/v3/builder", primaryType: "DelBuilder", params: [["builder", builder], ["asterChain", network], ["user", owner], ["nonce", nonce]] };
}

export function buildRevocation(owner: Hex, agent: Hex, ctx: AsterRevocationCtx): OnboardingBundle {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner) || !/^0x[0-9a-fA-F]{40}$/.test(agent)) throw new CapstanError("INVALID_INPUT", "owner and agent must be addresses");
  const agentTx = delAgentTx(owner, agent, ctx.network, nonceOf(ctx));
  const builderTx = delBuilderTx(owner, ctx.builder, ctx.network, nonceOf(ctx));
  return {
    bundleId: ulid(ctx.nowMs),
    venue: "aster",
    owner,
    steps: [mgmtStep("revoke_agent", agentTx), mgmtStep("revoke_builder", builderTx)],
    humanReadable: [`Remove agent ${agent} from your Aster account.`, `Remove builder ${ctx.builder} and its fee approval from your Aster account.`],
    templateHash: onboardingTemplateHash(ctx.builder, ctx.network),
    expiresAt: ctx.nowMs + ASTER_BUNDLE_TTL_MS,
  };
}
