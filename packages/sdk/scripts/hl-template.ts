// The Hyperliquid onboarding bundles this release's server builds, made offline for the SDK pins. It runs the real
// adapter build (createAdapter + buildOnboarding) with the real eligibility declaration step and the api's real agent
// policy step (policyStepOf), for a throwaway owner and agent address. The venue reader is a stand-in that answers like the
// public info API does for a brand-new wallet (no agents, no builder approvals), so no key, account, funds or network
// call is needed. The template hash keeps only the shape of the signed steps, so these bundles hash the same as any
// user's bundle on the same network.
import { createAdapter, HL_MAINNET, HL_TESTNET, type HlReader } from "@capstan/adapter-hyperliquid";
import { declarationStep } from "@capstan/eligibility";
import type { AgentPolicy, Hex, OnboardingBundle } from "@capstan/schema";
// the server's own agent_policy step, so a change to it changes these bundles too
import { policyStepOf } from "../../../apps/api/src/adapters";

export type PinNet = "mainnet" | "testnet";

/** Fixed throwaway addresses: nobody holds a key for them, and the hash does not depend on them. */
const OWNER = "0x00000000000000000000000000000000c0ffee01" as Hex;
const AGENT = "0x00000000000000000000000000000000c0ffee02" as Hex;
const BUILDER = "0x00000000000000000000000000000000c0ffee03" as Hex;
const NOW = 1_800_000_000_000;

/** What the public info API returns for a wallet that never used Hyperliquid (only the calls preflight makes). */
const freshWalletReader = {
  extraAgents: async () => [],
  approvedBuilders: async () => [],
  maxBuilderFee: async () => 0,
  accountDexes: async () => [null],
  dexAccount: async () => ({ collateralAsset: "USDC", withdrawable: "0" }),
} as unknown as HlReader;

/** A probe policy for the agent-safe bundle (its values do not change the template hash). */
export function probePolicy(): AgentPolicy {
  return { owner: OWNER, agents: [{ venue: "hyperliquid", agentRef: `hl:${AGENT}` }], maxNotionalPerOrderUsd: "1", maxGrossNotionalUsd: "1", maxLeverage: 1, allowedMarkets: "*", allowedVenues: ["hyperliquid"], maxOrdersPerDay: 1, expiresAt: new Date(NOW + 86_400_000).toISOString(), nonce: "template-probe" } as AgentPolicy;
}

/** The plain and the agent-safe (policy) onboarding bundles for one network, built by the production adapter code. */
export async function hlProbeBundles(net: PinNet): Promise<{ plain: OnboardingBundle; policy: OnboardingBundle }> {
  const cfg = { ...(net === "mainnet" ? HL_MAINNET : HL_TESTNET), builderAddress: BUILDER };
  const adapter = createAdapter(cfg, {
    http: null as never,
    cache: null as never,
    reader: freshWalletReader,
    now: () => NOW,
    onboarding: {
      declarationStep: (req) => declarationStep(req.owner, ["hyperliquid"], NOW),
      policyStep: (req) => policyStepOf((req as { policy?: unknown }).policy),
    },
  });
  const base = { venue: "hyperliquid" as const, owner: OWNER, agentAddress: AGENT, builderMaxBps: 3 };
  const plain = await adapter.buildOnboarding(base);
  const policy = await adapter.buildOnboarding({ ...base, policy: probePolicy() } as never);
  return { plain, policy };
}
