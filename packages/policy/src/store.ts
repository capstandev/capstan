// Policies are stored server-side as signed data (spec 7.6). A nonce is used once per owner. A newer policy for an
// agent supersedes the older one: the latest stored policy that names the agent is the one enforced (issuedAt is the
// store time). An older policy is marked revoked only when every agent it names is covered by a newer policy, so a
// supersede never leaves another agent without its limits.
import { schema, ulid, type Db } from "@capstan/core";
import { AgentPolicyZ, type AgentPolicy } from "@capstan/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Hex } from "@capstan/schema";
import { policyTimeMs, verifyPolicySig } from "./typed";

export type PolicyStoreCode = "INVALID" | "BAD_SIGNATURE" | "NONCE_REUSED" | "EXPIRED";

export class PolicyStoreError extends Error {
  readonly code: PolicyStoreCode;
  constructor(code: PolicyStoreCode, message: string) {
    super(message);
    this.name = "PolicyStoreError";
    this.code = code;
  }
}

export interface StoredPolicy {
  policyId: string;
  policy: AgentPolicy;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
}

const isUniqueViolation = (e: unknown): boolean => {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.code === "23505" || x?.cause?.code === "23505";
};

/** Validate, verify the owner's EIP-712 signature, refuse a reused nonce, store, and supersede older policies. */
export async function storePolicy(db: Db, p: AgentPolicy, sig: Hex, opts: { now?: () => Date; id?: () => string } = {}): Promise<{ policyId: string }> {
  const parsed = AgentPolicyZ.safeParse(p);
  if (!parsed.success) throw new PolicyStoreError("INVALID", parsed.error.issues.map((i) => `${i.path.join(".") || "policy"}: ${i.message}`).join("; "));
  const now = (opts.now ?? (() => new Date()))();
  if (policyTimeMs(p.expiresAt) <= now.getTime()) throw new PolicyStoreError("EXPIRED", "the policy has already expired");
  if (!verifyPolicySig(p, sig)) throw new PolicyStoreError("BAD_SIGNATURE", "the signature does not recover to the policy owner");
  const owner = p.owner.toLowerCase();
  const policyId = (opts.id ?? (() => ulid(now.getTime())))();
  const refs = [...new Set(p.agents.map((a) => a.agentRef))];
  // an agent that already exists must belong to the signer (a new agent named in its own onboarding has no row yet)
  const foreign = await db.select({ id: schema.delegations.id }).from(schema.delegations).where(and(inArray(schema.delegations.id, refs), sql`lower(${schema.delegations.owner}) <> ${owner}`)).limit(1);
  if (foreign.length) throw new PolicyStoreError("INVALID", `agent ${foreign[0]!.id} belongs to another owner`);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-policy:${owner}`}))`);
      const used = await tx.select({ id: schema.agentPolicies.id }).from(schema.agentPolicies).where(and(eq(schema.agentPolicies.owner, owner), eq(schema.agentPolicies.nonce, p.nonce))).limit(1);
      if (used.length) throw new PolicyStoreError("NONCE_REUSED", "this policy nonce was already used by the owner");
      await tx.insert(schema.agentPolicies).values({ id: policyId, owner, policy: p, ownerSig: sig, expiresAt: new Date(policyTimeMs(p.expiresAt)), revoked: false, nonce: p.nonce, agentRefs: refs, issuedAt: now });
      // supersede: an older live policy whose every agent now has a newer policy is revoked
      const live = await tx.select().from(schema.agentPolicies).where(and(eq(schema.agentPolicies.owner, owner), eq(schema.agentPolicies.revoked, false))).orderBy(desc(schema.agentPolicies.issuedAt), desc(schema.agentPolicies.id));
      const covered = new Set<string>();
      for (const row of live) {
        if (row.id !== policyId && row.agentRefs.every((r) => covered.has(r))) {
          await tx.update(schema.agentPolicies).set({ revoked: true }).where(eq(schema.agentPolicies.id, row.id));
        }
        for (const r of row.agentRefs) covered.add(r);
      }
    });
  } catch (e) {
    if (e instanceof PolicyStoreError) throw e;
    if (isUniqueViolation(e)) throw new PolicyStoreError("NONCE_REUSED", "this policy nonce was already used by the owner");
    throw e;
  }
  return { policyId };
}

function toStored(r: typeof schema.agentPolicies.$inferSelect): StoredPolicy {
  return { policyId: r.id, policy: r.policy as AgentPolicy, issuedAt: r.issuedAt.toISOString(), expiresAt: r.expiresAt.toISOString(), revoked: r.revoked };
}

/**
 * The policy enforced for an agent: the latest stored one that names it AND was signed by the agent's own owner (a
 * policy signed by anyone else never binds someone's agent). An expired latest policy is still returned (the check
 * then refuses with field expiresAt): an agent that once had a policy never falls back to no policy.
 */
export async function activePolicyFor(db: Db, agentRef: string, owner: Hex): Promise<StoredPolicy | null> {
  const rows = await db
    .select()
    .from(schema.agentPolicies)
    .where(and(eq(schema.agentPolicies.owner, owner.toLowerCase()), sql`${agentRef} = any(${schema.agentPolicies.agentRefs})`))
    .orderBy(desc(schema.agentPolicies.issuedAt), desc(schema.agentPolicies.id))
    .limit(1);
  return rows[0] ? toStored(rows[0]) : null;
}

export async function getPolicy(db: Db, policyId: string): Promise<StoredPolicy | null> {
  const rows = await db.select().from(schema.agentPolicies).where(eq(schema.agentPolicies.id, policyId)).limit(1);
  return rows[0] ? toStored(rows[0]) : null;
}
