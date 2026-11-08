// Kill switch (spec 7.6). A kill is a Redis flag `kill:<agentRef>` with no expiry plus a PUBLISH on `ps:kill`; the
// relay keeps an in-memory set fed by that subscription, so a kill reaches it in well under a second. The flag is
// permanent: the undo is a new onboarding with a new key (DECISIONS #7). Redis unreachable means "killed" for every
// lookup the in-memory set cannot answer (fail closed).
// Only the owner's signature or the agent's own signature kills (MON-1): no monitor or job calls kill().
// The kill stops the Capstan relay only. It cannot revoke a venue key; the response carries the venue revocation
// payloads for the owner's wallet to sign, and reduce-only close-all payloads when asked. Never a transfer or withdrawal.
import { bodyHash, MAX_FUTURE_SKEW_MS, MAX_VALIDITY_MS, parseCapstanMessage, recoverPersonalSigner, schema, ulid, type Db, type Redis } from "@capstan/core";
import type { BuildContext, Hex, OnboardingBundle, UnsignedVenuePayload, Unsubscribe, VenueAdapter, VenueId, VenueIdentity } from "@capstan/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";

export const KILL_CHANNEL = "ps:kill";
export const killKey = (agentRef: string) => `kill:${agentRef}`;

/** Plain statement returned with every kill (Overview honest limits). */
export const KILL_NOTE =
  "Capstan's relay now refuses this agent. This does not remove the key from the venue: only your wallet can do that, by signing the revocation steps below." as const;

export interface KillSwitch {
  kill(agentRef: string, by: "owner" | "agent", owner?: Hex): Promise<{ alreadyKilled: boolean }>;
  isKilled(agentRef: string): Promise<boolean>;
  subscribe(onKill: (agentRef: string) => void): Unsubscribe;
  close?(): Promise<void>;
}

export function redisKillSwitch(redis: Redis, db: Db | null, opts: { now?: () => Date } = {}): KillSwitch {
  const now = opts.now ?? (() => new Date());
  const local = new Set<string>();
  const listeners = new Set<(ref: string) => void>();
  let sub: Redis | null = null;
  let ready: Promise<unknown> | null = null;

  function ensureSubscriber(): void {
    if (sub) return;
    sub = redis.duplicate();
    sub.on("message", (channel: string, ref: string) => {
      if (channel !== KILL_CHANNEL) return;
      local.add(ref);
      for (const l of listeners) l(ref);
    });
    ready = sub.subscribe(KILL_CHANNEL);
  }

  return {
    async kill(agentRef, by, owner) {
      if (!agentRef) throw new Error("kill: agentRef is required");
      const set = await redis.set(killKey(agentRef), by, "NX");
      await redis.publish(KILL_CHANNEL, agentRef);
      local.add(agentRef);
      if (db) {
        let who = owner?.toLowerCase();
        if (!who) {
          const [d] = await db.select({ owner: schema.delegations.owner }).from(schema.delegations).where(eq(schema.delegations.id, agentRef)).limit(1);
          who = d?.owner.toLowerCase();
        }
        if (!who) throw new Error("kill: the owner of this agent is unknown");
        await db.insert(schema.killEvents).values({ id: ulid(now().getTime()), agentRef, owner: who, by, ts: now() });
        await db.update(schema.delegations).set({ state: "killed" }).where(eq(schema.delegations.id, agentRef));
      }
      return { alreadyKilled: set !== "OK" };
    },
    async isKilled(agentRef) {
      if (local.has(agentRef)) return true;
      try {
        const v = await redis.get(killKey(agentRef));
        if (v !== null) local.add(agentRef);
        return v !== null;
      } catch {
        return true; // fail closed
      }
    },
    subscribe(onKill) {
      ensureSubscriber();
      listeners.add(onKill);
      return () => {
        listeners.delete(onKill);
      };
    },
    async close() {
      if (sub) {
        await ready?.catch(() => undefined);
        await sub.quit().catch(() => undefined);
        sub = null;
      }
    },
  };
}

/** The nonce-store key for a kill message (same form as verifyCapstanMessage, so one store serves both). */
export const killNonceKey = (owner: string, nonce: string) => `kill:${owner}:${nonce}`;

export interface KillAuthExpect {
  host: string;
  nowMs: number;
  chainId?: number;
}

/**
 * Who signed a kill: the 01 capstanMessage with purpose 'kill' and body = agentRef (SIG-1), owner line = the agent's
 * owner, issued at most 5 minutes ago. 'owner' for the main wallet, 'agent' for the agent's own key (self-halt), else
 * null. The nonce (replay) is checked by the caller with its nonce store.
 */
export function verifyKillAuth(agentRef: string, message: string, sig: Hex, delegation: { owner: Hex; agentAddress?: Hex | null }, expect: KillAuthExpect): "owner" | "agent" | null {
  const m = parseCapstanMessage(message);
  if (!m || m.purpose !== "kill") return null;
  if (m.bodyHash !== bodyHash(agentRef)) return null;
  if (m.owner.toLowerCase() !== delegation.owner.toLowerCase()) return null;
  if (m.host !== expect.host) return null;
  if (expect.chainId !== undefined && m.chainId !== expect.chainId) return null;
  if (m.expiresAt - m.issuedAt > MAX_VALIDITY_MS) return null;
  if (expect.nowMs >= m.expiresAt || expect.nowMs - m.issuedAt > MAX_VALIDITY_MS || m.issuedAt > expect.nowMs + MAX_FUTURE_SKEW_MS) return null;
  const signer = recoverPersonalSigner(message, sig);
  if (!signer) return null;
  if (signer.toLowerCase() === delegation.owner.toLowerCase()) return "owner";
  if (delegation.agentAddress && signer.toLowerCase() === delegation.agentAddress.toLowerCase()) return "agent";
  return null;
}

/** The slice of an adapter the kill response needs. close-all builders differ per venue, so the caller binds them. */
export type KillAdapter = Pick<VenueAdapter, "caps" | "buildRevocation"> & {
  buildCloseAll?(id: VenueIdentity, ctx: BuildContext): Promise<UnsignedVenuePayload[]>;
};

export interface KillResponse {
  relayBlocked: true;
  agentRef: string;
  revocation: OnboardingBundle | null; // the agent's own venue
  revocations: OnboardingBundle[]; // every venue this key was onboarded on
  closeAll?: UnsignedVenuePayload[];
  unavailable: { venue: VenueId; reason: string }[];
  note: typeof KILL_NOTE;
}

const REVOKE_KINDS = new Set(["revoke_agent", "revoke_builder"]);
const MONEY = /withdraw|transfer|usdsend|spotsend|sendasset|vaulttransfer|subaccount|bridge/i;

/** Refuse anything in a kill response that could move funds. Throws on the first offending field. */
export function assertNoMoneyMovement(x: OnboardingBundle | UnsignedVenuePayload): void {
  if ("steps" in x) {
    for (const s of x.steps) if (!REVOKE_KINDS.has(s.kind)) throw new Error(`kill response: step ${s.kind} is not a revocation`);
  } else if (x.preview?.reduceOnly !== true) {
    throw new Error("kill response: a close-all payload must be reduce-only");
  }
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      if (MONEY.test(v)) throw new Error(`kill response: ${path} names a fund movement`);
    } else if (Array.isArray(v)) v.forEach((e, i) => walk(e, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, e] of Object.entries(v)) {
      if (MONEY.test(k)) throw new Error(`kill response: ${path}.${k} names a fund movement`);
      walk(e, `${path}.${k}`);
    }
  };
  // text the user reads is plain English and may say "never moves funds"; only machine fields are scanned
  const { humanReadable: _h, ...machine } = x as OnboardingBundle;
  walk(machine, "$");
}

type DelegationRow = typeof schema.delegations.$inferSelect;

export function identityOf(d: DelegationRow): VenueIdentity {
  return {
    venue: d.venue as VenueId,
    owner: d.owner as Hex,
    ...(d.accountIndex !== null ? { accountIndex: d.accountIndex } : {}),
    ...(d.agentAddress ? { agentAddress: d.agentAddress as Hex } : {}),
    ...(d.apiKeyIndex !== null ? { apiKeyIndex: d.apiKeyIndex } : {}),
  };
}

export interface KillResponseDeps {
  adapters: Map<VenueId, KillAdapter>;
  db: Db;
  closeAll: boolean;
  /** Build context for close-all payloads (no builder fee on a close). */
  buildContext?: (id: VenueIdentity, agentRef: string) => BuildContext;
  now?: () => number;
  /** The replacement Lighter API public key from the kill request (Lighter revocations rotate the key slot to it). */
  replacementPubKey?: string;
}

const LIGHTER_VENUES = new Set<VenueId>(["lighter-mainnet", "lighter-rh"]);
const whyNot = (e: unknown): string => (e instanceof Error && e.message ? e.message : "the venue could not build it here").slice(0, 200);

/** Revocation bundles for every venue the agent's key was onboarded on, plus reduce-only close-alls when asked. */
export async function buildKillResponse(agentRef: string, deps: KillResponseDeps): Promise<KillResponse> {
  const now = deps.now ?? Date.now;
  const [own] = await deps.db.select().from(schema.delegations).where(eq(schema.delegations.id, agentRef)).limit(1);
  if (!own) throw new Error(`unknown agent ${agentRef}`);
  const rows: DelegationRow[] = [own];
  if (own.agentAddress) {
    const same = await deps.db
      .select()
      .from(schema.delegations)
      .where(and(eq(schema.delegations.owner, own.owner), isNotNull(schema.delegations.agentAddress), sql`lower(${schema.delegations.agentAddress}) = ${own.agentAddress.toLowerCase()}`));
    for (const r of same) if (r.id !== own.id) rows.push(r);
  }
  const out: KillResponse = { relayBlocked: true, agentRef, revocation: null, revocations: [], unavailable: [], note: KILL_NOTE };
  const closes: UnsignedVenuePayload[] = [];
  for (const d of rows) {
    const venue = d.venue as VenueId;
    const a = deps.adapters.get(venue);
    if (!a) {
      out.unavailable.push({ venue, reason: "venue adapter not configured on this host; sign the revocation from the venue's own app" });
      continue;
    }
    const id = identityOf(d);
    // one venue failing never costs the owner the others (security r2 D2-ADP-02, D2-ADP-03): each venue's
    // revocation and close-all is tried on its own and a failure is listed in unavailable
    if (LIGHTER_VENUES.has(venue) && !deps.replacementPubKey) {
      out.unavailable.push({ venue, reason: "a Lighter revocation needs replacementPubKey (the new API public key your SDK made); send it with the kill, or rotate the key from Lighter's own app" });
    } else {
      let bundle: OnboardingBundle | null = null;
      try {
        bundle = await a.buildRevocation(LIGHTER_VENUES.has(venue) ? ({ ...id, replacementPubKey: deps.replacementPubKey } as VenueIdentity) : id);
      } catch (e) {
        out.unavailable.push({ venue, reason: `revocation unavailable: ${whyNot(e)}` });
      }
      if (bundle) {
        assertNoMoneyMovement(bundle); // a money-moving bundle is a bug: the whole kill answer fails, never hands it out
        out.revocations.push(bundle);
        if (d.id === own.id) out.revocation = bundle;
      }
    }
    if (deps.closeAll) {
      if (!a.buildCloseAll) {
        out.unavailable.push({ venue, reason: "close-all is not available for this venue here" });
        continue;
      }
      const ctx: BuildContext = deps.buildContext?.(id, d.id) ?? { owner: d.owner as Hex, agentRef: d.id, identity: id, builderFee: null, approvedMaxBps: null, nowMs: now(), eligibilityDecisionId: "not-required:kill", policyId: null };
      let legs: UnsignedVenuePayload[] | null = null;
      try {
        legs = await a.buildCloseAll(id, ctx);
      } catch (e) {
        out.unavailable.push({ venue, reason: `close-all unavailable: ${whyNot(e)}` });
      }
      for (const p of legs ?? []) {
        assertNoMoneyMovement(p);
        closes.push(p);
      }
    }
  }
  if (deps.closeAll) out.closeAll = closes;
  return out;
}
