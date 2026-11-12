// Agent-safe onboarding (spec 7.6): the agent_policy step the owner signs in an onboarding bundle is verified at
// /onboarding/submit BEFORE any venue step is sent, and stored (storePolicy, the same code POST /v1/agents/policy
// runs; a nonce is used once) once the venue has the agent, so the relay finds it for the new agent at once. A bad or
// mismatched signature, a used nonce, an expired policy or a policy that does not name the new agent refuses the
// submit with nothing sent. A bundle without a policy step changes nothing.
import { schema, type Db } from "@capstan/core";
import { PolicyStoreError, policyTimeMs, storePolicy, verifyPolicySig } from "@capstan/policy";
import { AgentPolicyZ, CapstanError, type AgentPolicy, type Hex, type OnboardingBundle, type VenueId } from "@capstan/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

export interface PendingPolicy {
  policy: AgentPolicy;
  sig: Hex;
  /** The agentRef the venue step will register; the policy names it. */
  agentRef: string;
}

/** The agentRef the bundle registers, known before the venue step (the adapters' own formats). */
export function expectedAgentRef(venue: VenueId, owner: string, agentAddress: string | null | undefined, bundle: OnboardingBundle): string | null {
  if (venue === "hyperliquid") return agentAddress ? `hl:${agentAddress.toLowerCase()}` : null;
  if (venue === "aster") return agentAddress ? `aster:${owner.toLowerCase()}:${agentAddress.toLowerCase()}` : null;
  const step = bundle.steps.find((s) => s.kind === "lighter_change_pubkey");
  const a = (step?.venueTx as { args?: { accountIndex?: unknown; apiKeyIndex?: unknown } } | undefined)?.args;
  return a && a.accountIndex !== undefined && a.apiKeyIndex !== undefined ? `${venue}:${a.accountIndex}:${a.apiKeyIndex}` : null;
}

const bad = (message: string, field = "policy") => new CapstanError("INVALID_INPUT", message, { field });

/**
 * Check the signed policy of a bundle before the venue step. Returns null when the bundle has no policy step and the
 * build asked for none. Throws CapstanError (nothing is sent) on any problem.
 */
export async function verifyOnboardingPolicy(
  db: Db,
  o: { venue: VenueId; owner: string; bundle: OnboardingBundle; requestPolicy: unknown; agentAddress: string | null | undefined; signatures: { step: number; sig: Hex }[]; nowMs: number },
): Promise<PendingPolicy | null> {
  const pi = o.bundle.steps.findIndex((st) => st.kind === "agent_policy");
  const asked = o.requestPolicy !== null && o.requestPolicy !== undefined;
  if (pi < 0 && !asked) return null;
  // a policy asked for but missing from the bundle is refused: agent-safe mode never falls back to no policy
  if (pi < 0) throw bad(`Agent-safe mode is not available for ${o.venue} onboarding: the bundle has no policy step.`);
  if (!asked) throw bad("The bundle has a policy step but no policy was built. Build it again.");
  const parsed = AgentPolicyZ.safeParse(o.requestPolicy);
  if (!parsed.success) throw bad("The policy in this bundle is not valid. Build it again.");
  const policy = o.requestPolicy as AgentPolicy;
  const sig = o.signatures.find((x) => x.step === pi)?.sig;
  if (!sig) throw bad("The agent policy step is not signed.");
  if (policy.owner.toLowerCase() !== o.owner.toLowerCase()) throw new CapstanError("UNAUTHORIZED", "The policy names another owner.");
  if (!verifyPolicySig(policy, sig)) throw new CapstanError("UNAUTHORIZED", "The policy signature does not match its owner.");
  if (policyTimeMs(policy.expiresAt) <= o.nowMs) throw bad("The policy has already expired.", "policy.expiresAt");
  const agentRef = expectedAgentRef(o.venue, o.owner, o.agentAddress, o.bundle);
  if (!agentRef || !policy.agents.some((a) => a.agentRef === agentRef && a.venue === o.venue)) throw bad("The policy does not name the agent this onboarding registers.", "policy.agents");
  const owner = o.owner.toLowerCase();
  const used = await db.select({ id: schema.agentPolicies.id }).from(schema.agentPolicies).where(and(eq(schema.agentPolicies.owner, owner), eq(schema.agentPolicies.nonce, policy.nonce))).limit(1);
  if (used.length) throw bad("This policy nonce was already used by the owner.", "policy.nonce");
  const refs = [...new Set(policy.agents.map((a) => a.agentRef))];
  const foreign = await db.select({ id: schema.delegations.id }).from(schema.delegations).where(and(inArray(schema.delegations.id, refs), sql`lower(${schema.delegations.owner}) <> ${owner}`)).limit(1);
  if (foreign.length) throw bad(`agent ${foreign[0]!.id} belongs to another owner`, "policy.agents");
  return { policy, sig, agentRef };
}

/** Store the verified policy for the agent the venue registered (storePolicy, as POST /v1/agents/policy does). */
export async function storeOnboardingPolicy(db: Db, p: PendingPolicy, registeredRef: string, nowMs: number): Promise<string> {
  if (registeredRef !== p.agentRef) throw bad("The venue registered another agent than the policy names.", "policy.agents");
  try {
    return (await storePolicy(db, p.policy, p.sig, { now: () => new Date(nowMs) })).policyId;
  } catch (e) {
    if (e instanceof PolicyStoreError) {
      if (e.code === "BAD_SIGNATURE") throw new CapstanError("UNAUTHORIZED", "The policy signature does not match its owner.");
      throw bad(e.message);
    }
    throw e;
  }
}
