// Revocation (spec 7.6 kill switch): the documented way to deregister a named agent is ApproveAgent with the SAME
// name and a fresh throwaway address; a short valid_until (now + 1 minute) lets the replacement lapse at once.
// A builder revoke (`maxFeeRate "0%"`) is only included behind HL_BUILDER_REVOKE_CONFIRMED (BACKLOG A2), and the
// zero-address agent revoke is never built until a testnet run confirms it.
import { ulid } from "@capstan/core";
import { CapstanError, type Hex, type OnboardingBundle, type OnboardingStep, type VenueIdentity } from "@capstan/schema";
import { agentNameWithExpiry, parseAgentName, type HlNetwork } from "@capstan/signer-hl";
import { approveAgentStep, approveBuilderFeeStep, templateHash } from "./templates";
import { shortAddr } from "./onboarding";

export const REVOKE_AGENT_VALIDITY_MS = 60_000;
const ZERO = "0x0000000000000000000000000000000000000000";

export interface HlRevocationContext {
  network: HlNetwork;
  signatureChainId: Hex;
  nowMs: number;
  throwawayAgent: Hex;
  /** Builder to revoke, only used when the flag is on. */
  builder?: Hex;
  /** Defaults to process.env.HL_BUILDER_REVOKE_CONFIRMED === "1". */
  builderRevokeConfirmed?: boolean;
}

export async function buildRevocation(id: VenueIdentity & { agentName: string }, ctx: HlRevocationContext): Promise<OnboardingBundle> {
  const owner = id.owner.toLowerCase() as Hex;
  const throwaway = ctx.throwawayAgent.toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{40}$/.test(throwaway) || throwaway === ZERO) throw new CapstanError("INVALID_INPUT", "the replacement must be a fresh non-zero address");
  if (id.agentAddress && throwaway === id.agentAddress.toLowerCase()) throw new CapstanError("INVALID_INPUT", "the replacement must differ from the agent being revoked");
  if (throwaway === owner) throw new CapstanError("INVALID_INPUT", "the replacement cannot be the owner");
  const { name } = parseAgentName(id.agentName);
  if (!name) throw new CapstanError("INVALID_INPUT", "a named agent is required (the unnamed agent is never touched)");
  const steps: OnboardingStep[] = [];
  const lines: string[] = [];
  let nonce = ctx.nowMs;
  steps.push(approveAgentStep({ network: ctx.network, signatureChainId: ctx.signatureChainId, nonce: nonce++, agentAddress: throwaway, agentName: agentNameWithExpiry(name, ctx.nowMs + REVOKE_AGENT_VALIDITY_MS, ctx.nowMs) }, "revoke_agent"));
  lines.push(`Stop agent ${name}${id.agentAddress ? ` (${shortAddr(id.agentAddress)})` : ""}: it is replaced by an unused key that expires in one minute.`);
  const confirmed = ctx.builderRevokeConfirmed ?? process.env.HL_BUILDER_REVOKE_CONFIRMED === "1";
  if (confirmed) {
    if (!ctx.builder) throw new CapstanError("INVALID_INPUT", "the builder address is needed for a builder revoke");
    steps.push(approveBuilderFeeStep({ network: ctx.network, signatureChainId: ctx.signatureChainId, nonce: nonce++, builder: ctx.builder, maxFeeRate: "0%" }, "revoke_builder"));
    lines.push(`Set the Capstan builder fee approval on Hyperliquid to 0% (builder ${ctx.builder.toLowerCase()}).`);
  }
  return { bundleId: ulid(ctx.nowMs), venue: "hyperliquid", owner, steps, humanReadable: lines, templateHash: templateHash({ venue: "hyperliquid", steps }), expiresAt: ctx.nowMs + 15 * 60 * 1000 };
}
