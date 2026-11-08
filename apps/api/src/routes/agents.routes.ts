// Agent-safe mode routes (spec 7.6, 13.1).
// POST /v1/agents/policy: store a CapstanAgentPolicy signed by the main wallet (EIP-712). A nonce is used once.
// POST /v1/agents/{agentRef}/kill: the owner's signature or the agent's own signature (self-halt) on the 01
//   capstanMessage with purpose 'kill' and body = agentRef, issued within 5 minutes. The relay refuses the agent at
//   once (Redis flag + pub/sub). The answer carries the venue revocation payloads for the owner's wallet and, when
//   asked, reduce-only close-all payloads. Every kill writes kill_events and an agent.kill receipt. A replayed kill
//   message changes nothing and answers the same kill state.
// The kill stops Capstan's relay only; it cannot remove the key from the venue. The answer says so.
import { createDb, createQueue, createRedis, redisNonceStore, schema, type Db, type NonceStore, type RouteSpec } from "@capstan/core";
import { withVenueLane } from "@capstan/venue-client";
import { activePolicyFor, buildKillResponse, killNonceKey, PolicyStoreError, redisKillSwitch, storePolicy, verifyKillAuth, type KillAdapter, type KillSwitch } from "@capstan/policy";
import { drafts, jcs, type ReceiptDraft } from "@capstan/receipts";
import { AgentKillZ, AgentPolicySubmitZ, errorBody, type AgentPolicy, type Hex, type VenueId } from "@capstan/schema";
import { parseCapstanMessage } from "@capstan/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { eq } from "drizzle-orm";
import type { Context } from "hono";

/** Issues a receipt now (receipt service) or queues it for the receipt-sign worker; returns the id or the job key. */
export interface ReceiptIssuer {
  issue(d: ReceiptDraft): Promise<{ receiptId: string | null; queued?: string }>;
}

export interface AgentRouteDeps {
  db: Db;
  killSwitch: KillSwitch;
  nonces: NonceStore;
  receipts: ReceiptIssuer;
  adapters: Map<VenueId, KillAdapter>;
  host: string;
  now?: () => number;
}

/** Kills need no eligibility decision: a refused region must still be able to stop its own agent. */
export const KILL_ELIGIBILITY_ID = "not-required:kill";

const hashOf = (v: unknown): Hex => `0x${bytesToHex(sha256(utf8ToBytes(jcs(v))))}` as Hex;

async function json(c: Context): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; ");

export function createAgentRoutes(getDeps: () => Promise<AgentRouteDeps> | AgentRouteDeps): RouteSpec[] {
  return [
    {
      method: "POST",
      path: "/agents/policy",
      auth: "owner_sig",
      description: "Store an agent policy signed by your main wallet",
      async handler(c) {
        const body = await json(c);
        if (body === undefined) return c.json(errorBody("INVALID_INPUT", "body must be JSON"), 400);
        const parsed = AgentPolicySubmitZ.safeParse(body);
        if (!parsed.success) return c.json(errorBody("INVALID_INPUT", issues(parsed.error)), 400);
        const deps = await getDeps();
        const now = deps.now ?? Date.now;
        try {
          const { policyId } = await storePolicy(deps.db, parsed.data.policy as AgentPolicy, parsed.data.ownerSig as Hex, { now: () => new Date(now()) });
          return c.json({ policyId, mode: "relay", note: "Agent-safe mode sends every order through the relay, which checks this policy." });
        } catch (e) {
          if (e instanceof PolicyStoreError) {
            if (e.code === "BAD_SIGNATURE") return c.json(errorBody("UNAUTHORIZED", "The policy signature does not match its owner."), 401);
            return c.json(errorBody("INVALID_INPUT", e.message), 400);
          }
          throw e;
        }
      },
    },
    {
      method: "POST",
      path: "/agents/:agentRef/kill",
      auth: "owner_sig", // or the agent's own signature (self-halt), checked here
      description: "Stop an agent on the Capstan relay and get the venue revocation steps for your wallet",
      async handler(c) {
        const agentRef = c.req.param("agentRef") ?? "";
        const body = await json(c);
        if (body === undefined) return c.json(errorBody("INVALID_INPUT", "body must be JSON"), 400);
        const parsed = AgentKillZ.safeParse(body);
        if (!parsed.success) return c.json(errorBody("INVALID_INPUT", issues(parsed.error)), 400);
        const deps = await getDeps();
        const nowMs = (deps.now ?? Date.now)();
        const { sig, message } = parsed.data;
        const closeAll = parsed.data.closeAll === true;
        const ts = (body as { ts?: unknown }).ts;
        const [dg] = await deps.db.select().from(schema.delegations).where(eq(schema.delegations.id, agentRef)).limit(1);
        if (!dg) return c.json(errorBody("NOT_FOUND", "Unknown agent."), 404);
        const by = verifyKillAuth(agentRef, message, sig as Hex, { owner: dg.owner as Hex, agentAddress: (dg.agentAddress as Hex | null) ?? null }, { host: deps.host, nowMs });
        const m = parseCapstanMessage(message);
        if (!by || !m) return c.json(errorBody("UNAUTHORIZED", "A kill must be signed by the owner or by the agent itself, within 5 minutes."), 401);
        if (ts !== undefined && ts !== m.issuedAt) return c.json(errorBody("INVALID_INPUT", "ts must equal the signed issue time"), 400);
        const owner = dg.owner.toLowerCase() as Hex;
        if (await deps.nonces.seen(killNonceKey(owner, m.nonce))) {
          // a replayed kill message is harmless: it never toggles anything and answers the current state
          if (await deps.killSwitch.isKilled(agentRef)) return c.json({ relayBlocked: true, agentRef, replayed: true });
          return c.json(errorBody("UNAUTHORIZED", "This kill message was already used."), 401);
        }
        const { alreadyKilled } = await deps.killSwitch.kill(agentRef, by, owner);
        const policy = await activePolicyFor(deps.db, agentRef, owner);
        const receipt = await deps.receipts.issue(
          drafts.agentKill({ owner, agentRef, venue: dg.venue as VenueId, policyId: policy?.policyId ?? null, requestHash: hashOf({ agentRef, sig, message, closeAll }), eligibilityDecisionId: KILL_ELIGIBILITY_ID }),
        );
        // revocation and close-all reads run in the safety lane (D2-ADP-05)
        const res = await withVenueLane("safety", () => buildKillResponse(agentRef, { adapters: deps.adapters, db: deps.db, closeAll, now: () => nowMs, ...(parsed.data.replacementPubKey ? { replacementPubKey: parsed.data.replacementPubKey } : {}) }));
        return c.json({ ...res, by, alreadyKilled, receiptId: receipt.receiptId, ...(receipt.queued ? { receiptQueued: receipt.queued } : {}) });
      },
    },
  ];
}

/** Receipt issuer for the api host: the receipt-sign worker holds the key, so the draft is queued (idempotent job id). */
export function queuedReceiptIssuer(queue: { add(name: string, data: unknown, opts: { jobId: string; removeOnComplete: number; removeOnFail: number }): Promise<unknown> }): ReceiptIssuer {
  return {
    async issue(d) {
      const jobId = `rc-${d.requestHash.slice(2, 34)}`;
      await queue.add("receipt-sign", { draft: d }, { jobId, removeOnComplete: 1000, removeOnFail: 5000 });
      return { receiptId: null, queued: jobId };
    },
  };
}

let resolved: Promise<AgentRouteDeps> | null = null;

/** Wiring from the environment. Venue adapters come from the shared composition (apps/api/src/adapters.ts, todo 29). */
async function envDeps(): Promise<AgentRouteDeps> {
  const env = process.env;
  if (!env.DATABASE_URL || !env.REDIS_URL) throw new Error("agents routes need DATABASE_URL and REDIS_URL");
  const db = createDb(env.DATABASE_URL, { max: 4 });
  const redis = createRedis(env.REDIS_URL);
  const adapters = new Map<VenueId, KillAdapter>();
  try {
    const mod = (await import(`${import.meta.dir}/../adapters.ts`)) as { killAdapters?: () => Promise<Map<VenueId, KillAdapter>> | Map<VenueId, KillAdapter> };
    if (mod.killAdapters) for (const [k, v] of await mod.killAdapters()) adapters.set(k, v);
  } catch {
    // no composition yet: kills still block the relay; the answer lists each venue as unavailable for revocation
  }
  return {
    db,
    killSwitch: redisKillSwitch(redis, db),
    nonces: redisNonceStore(redis),
    receipts: queuedReceiptIssuer(createQueue("receiptSign", createRedis(env.REDIS_URL, { forBullmq: true }))),
    adapters,
    host: env.PUBLIC_API_HOST ?? "localhost:8710",
  };
}

export const routes: RouteSpec[] = createAgentRoutes(() => (resolved ??= envDeps()));
