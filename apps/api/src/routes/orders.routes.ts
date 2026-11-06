// Order routes (spec 7.3, 13.1). Every build returns an UNSIGNED payload for the delegated key to sign on the client;
// nothing here accepts a key. Builds are refused before anything is signed when the venue is data only, the market is
// not executable, the builder approval is missing, or the agent policy would be breached; each 403 carries the id
// of a signed refusal receipt. Builds live 30 s in order_builds. Submit enqueues relay-submit and waits up to 10 s.
// No amend route exists: an amendment is a cancel build plus a new order build, signed twice (DECISIONS #54).
import { createDb, createRedis, schema, ulid, type Db, type RouteSpec } from "@capstan/core";
import { checkPolicy } from "@capstan/policy";
import { draft, type ReceiptDraft } from "@capstan/receipts";
import {
  dbPolicySource,
  memoryKillView,
  pgRelayStore,
  queuedReceipts,
  relayFlags,
  relayQueueClient,
  relayVenues,
  saveBuild,
  sha256Jcs,
  handleClaim,
  type ClaimDeps,
  type ClaimRequest,
  type RelayClient,
  type RelayDeps,
  type BuildKind,
  type StoredBuild,
} from "@capstan/relay";
import { CancelBuildZ, CapstanError, CloseAllBuildZ, errorBody, OrderBuildZ, OrderSubmitZ, type BuildContext, type ErrorCode, type Hex, type OrderIntent, type UnsignedVenuePayload, type VenueId, type VenueIdentity } from "@capstan/schema";
import { buildContextFee, STANDARD_FEE, type BuilderFee } from "@capstan/plans";
import type { Priority } from "@capstan/venue-client";
import { clientIp } from "@capstan/eligibility";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { BuildAdapter } from "../adapters";

export const BUILD_REFUSALS: readonly ErrorCode[] = ["VENUE_DATA_ONLY", "MARKET_NOT_EXECUTABLE", "BUILDER_APPROVAL_REQUIRED", "FEE_FREE_UNAVAILABLE", "POLICY_BREACH", "RETIRED_AGENT", "AGENT_KILLED"];

export interface OrdersRouteDeps {
  db: Db;
  adapters: Map<VenueId, BuildAdapter>;
  relay: RelayClient;
  claim: (req: ClaimRequest) => Promise<{ receiptId: string }>;
  policy: RelayDeps["policy"];
  usage: RelayDeps["store"]["agentUsage"];
  issue: (d: ReceiptDraft) => Promise<{ receiptId: string }>;
  alerts: RelayDeps["alerts"];
  /** Builder fee by tier (todo 34): STANDARD_FEE, or LOCK_FEE for lock tiers. */
  feeOf: (owner: Hex, apiKeyId?: string) => Promise<BuilderFee>;
  /** Relay lane of the caller (cancels and closes always run as safety). */
  laneOf: (owner: Hex, apiKeyId?: string) => Promise<"free" | "pro">;
  isExecutable?: (marketId: string) => Promise<boolean>;
  ipOf?: (c: Context) => string;
  now: () => number;
}

const ctxGet = (c: Context, k: string): unknown => (c as unknown as { get(k: string): unknown }).get(k);
const ctxSet = (c: Context, k: string, v: unknown): void => (c as unknown as { set(k: string, v: unknown): void }).set(k, v);

async function json(c: Context): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}
const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; ");
const fail = (c: Context, code: ErrorCode, message?: string, receiptId?: string) => c.json(errorBody(code, message, receiptId), (new CapstanError(code).status as 400));

/** A 403 at build time: a signed refusal receipt first, then the error with its id. */
async function refuseBuild(c: Context, deps: OrdersRouteDeps, code: ErrorCode, o: { owner: Hex; agentRef: string | null; venue: VenueId | null; marketId: string | null; body: unknown; message?: string; field?: string }): Promise<Response> {
  let receiptId: string | undefined;
  try {
    const r = await deps.issue(
      draft("refusal", {
        requestHash: sha256Jcs({ route: c.req.path, body: o.body ?? null, code, field: o.field ?? null }),
        eligibilityDecisionId: String(ctxGet(c, "eligibilityDecisionId") ?? `build:${code}`),
        owner: o.owner.toLowerCase() as Hex,
        agentRef: o.agentRef,
        venue: o.venue,
        marketId: o.marketId,
      }),
    );
    receiptId = r.receiptId;
  } catch {
    receiptId = undefined;
  }
  return fail(c, code, o.message, receiptId);
}

interface Agent {
  id: string;
  venue: VenueId;
  owner: Hex;
  identity: VenueIdentity;
  builderMaxBps: number | null;
}

async function agentOf(db: Db, agentRef: string, owner: Hex): Promise<Agent | "retired" | "killed" | null> {
  const [d] = await db.select().from(schema.delegations).where(eq(schema.delegations.id, agentRef)).limit(1);
  if (!d || d.owner.toLowerCase() !== owner.toLowerCase()) return null;
  if (d.state === "killed") return "killed";
  if (d.state !== "active" || (d.expiresAt && d.expiresAt.getTime() <= Date.now())) return "retired";
  const identity: VenueIdentity = { venue: d.venue as VenueId, owner: d.owner as Hex, ...(d.agentAddress ? { agentAddress: d.agentAddress as Hex } : {}), ...(d.accountIndex !== null ? { accountIndex: d.accountIndex } : {}), ...(d.apiKeyIndex !== null ? { apiKeyIndex: d.apiKeyIndex } : {}) };
  return { id: d.id, venue: d.venue as VenueId, owner: d.owner as Hex, identity, builderMaxBps: d.builderMaxBps };
}

/** owner_sig must have been made by the owner the request names (or one of its agents); an api_key names anyone. */
function ownerMatches(c: Context, owner: Hex): boolean {
  const authed = ctxGet(c, "owner");
  return typeof authed !== "string" || authed.toLowerCase() === owner.toLowerCase();
}

function buildCtx(c: Context, a: Agent, fee: BuilderFee, o: { policyId: string | null; mode: "relay" | "direct"; requestHash: Hex; nowMs: number; closing?: boolean }): BuildContext & Record<string, unknown> {
  return {
    owner: a.owner,
    agentRef: a.id,
    identity: a.identity,
    builderFee: o.closing ? null : buildContextFee(fee, a.venue),
    approvedMaxBps: a.builderMaxBps,
    nowMs: o.nowMs,
    eligibilityDecisionId: String(ctxGet(c, "eligibilityDecisionId") ?? ""),
    policyId: o.policyId,
    mode: o.mode,
    requestHash: o.requestHash,
    agentState: "active",
    snapshot: null,
  };
}

/** Quote check (spec 7.3 step 2): the build's own walk must stay inside the slippage the intent allows, on fresh data. */
export function quoteCheck(b: UnsignedVenuePayload, intent: OrderIntent): ErrorCode | null {
  if (b.preview.warnings.some((w) => /stale/i.test(w))) return "STALE_QUOTE";
  if (intent.type === "market" && b.preview.slippageBps > intent.maxSlippageBps) return "STALE_QUOTE";
  return null;
}

async function store(deps: OrdersRouteDeps, b: UnsignedVenuePayload, a: Agent, kind: BuildKind, o: { mode: "relay" | "direct"; requestHash: Hex; policyId: string | null; leverage: number; intent: OrderIntent | null }) {
  await saveBuild(deps.db, { build: b, owner: a.owner, agentRef: a.id, facts: { intent: o.intent, kind, mode: o.mode, requestHash: o.requestHash, policyId: o.policyId, leverage: o.leverage } });
}

const asCapstan = (e: unknown): CapstanError | null => (e instanceof CapstanError ? e : (e as { code?: string })?.code && (e as { status?: number }).status ? (e as CapstanError) : null);

export function createOrderRoutes(getDeps: () => Promise<OrdersRouteDeps> | OrdersRouteDeps): RouteSpec[] {
  const buildRoute: RouteSpec = {
    method: "POST",
    path: "/orders/build",
    auth: "owner_sig",
    authAlt: ["api_key"],
    description: "Build an unsigned order payload for your delegated key to sign",
    write: { action: "order", marketId: (_c, body) => ((body as { intent?: { marketId?: unknown } } | null)?.intent?.marketId as string | undefined) ?? null },
    async handler(c) {
      const body = await json(c);
      const parsed = OrderBuildZ.safeParse(body);
      if (!parsed.success) return fail(c, "INVALID_INPUT", issues(parsed.error));
      const deps = await getDeps();
      const { owner, agentRef, intent, mode } = parsed.data as { owner: Hex; agentRef: string; intent: OrderIntent; mode: "relay" | "direct" };
      if (!ownerMatches(c, owner)) return fail(c, "UNAUTHORIZED", "The signature does not belong to this owner.");
      const venue = intent.marketId.split(":")[0] as VenueId;
      const base = { owner, agentRef, venue, marketId: intent.marketId, body };
      const a = await agentOf(deps.db, agentRef, owner);
      if (a === null || a === "retired") return refuseBuild(c, deps, "RETIRED_AGENT", base);
      if (a === "killed") return refuseBuild(c, deps, "AGENT_KILLED", base);
      if (a.venue !== venue) return fail(c, "INVALID_INPUT", "The market is not on this agent's venue.");
      const adapter = deps.adapters.get(venue);
      if (!adapter) return fail(c, "UNSUPPORTED_VENUE");
      if (!adapter.caps.execution) return refuseBuild(c, deps, "VENUE_DATA_ONLY", base);
      if (deps.isExecutable && !(await deps.isExecutable(intent.marketId))) return refuseBuild(c, deps, "MARKET_NOT_EXECUTABLE", base);
      const nowMs = deps.now();
      const policy = await deps.policy.active(agentRef, owner);
      const requestHash = sha256Jcs(body);
      const apiKeyId = ctxGet(c, "apiKeyId") as string | undefined;
      let b: UnsignedVenuePayload;
      try {
        b = await adapter.buildOrder(intent, buildCtx(c, a, await deps.feeOf(owner, apiKeyId), { policyId: policy?.policyId ?? null, mode, requestHash, nowMs }));
      } catch (e) {
        const ce = asCapstan(e);
        if (ce && BUILD_REFUSALS.includes(ce.code)) return refuseBuild(c, deps, ce.code, { ...base, message: ce.message });
        if (ce) return fail(c, ce.code, ce.message, ce.receiptId);
        throw e;
      }
      if (policy) {
        const u = await deps.usage(agentRef, nowMs);
        const r = checkPolicy({ policy: policy.policy, agentRef, venue, marketId: intent.marketId, side: intent.side, notionalUsd: b.preview.notionalUsd, leverage: intent.leverage ?? 1, reduceOnly: intent.reduceOnly, grossNotionalUsd: u.grossNotionalUsd, ordersToday: u.ordersToday, nowMs, mode });
        if (!r.ok) {
          await deps.alerts.policyBreach({ owner, agentRef, field: r.field, buildId: b.buildId }).catch(() => undefined);
          return refuseBuild(c, deps, "POLICY_BREACH", { ...base, field: r.field, message: `The request breaches the agent policy (${r.field}).` });
        }
      }
      const q = quoteCheck(b, intent);
      if (q) return fail(c, q);
      await store(deps, b, a, "order", { mode, requestHash, policyId: policy?.policyId ?? null, leverage: intent.leverage ?? 1, intent });
      return c.json(b);
    },
  };

  const cancelRoute: RouteSpec = {
    method: "POST",
    path: "/orders/cancel/build",
    auth: "owner_sig",
    authAlt: ["api_key"],
    description: "Build an unsigned cancel payload",
    write: {
      action: "order",
      // the market may be left out: the venue then comes from the agent's delegation
      async venue(_c, body) {
        const b = body as { marketId?: unknown; agentRef?: unknown } | null;
        if (typeof b?.marketId === "string") return b.marketId.split(":")[0] ?? null;
        if (typeof b?.agentRef !== "string") return null;
        const deps = await getDeps();
        const [d] = await deps.db.select({ venue: schema.delegations.venue }).from(schema.delegations).where(eq(schema.delegations.id, b.agentRef)).limit(1);
        return d?.venue ?? null;
      },
    },
    async handler(c) {
      const body = await json(c);
      const parsed = CancelBuildZ.safeParse(body);
      if (!parsed.success) return fail(c, "INVALID_INPUT", issues(parsed.error));
      const deps = await getDeps();
      const { owner, agentRef, venueOrderId, clientOrderId } = parsed.data as { owner: Hex; agentRef: string; marketId?: string; venueOrderId?: string; clientOrderId?: string };
      let marketId = (parsed.data as { marketId?: string }).marketId;
      if (!marketId && venueOrderId) {
        // the owner's own order on record names its market
        const [o] = await deps.db.select({ marketId: schema.orders.marketId }).from(schema.orders).where(and(eq(schema.orders.owner, owner.toLowerCase()), eq(schema.orders.venueOrderId, venueOrderId))).limit(1);
        marketId = o?.marketId;
      }
      if (!marketId) return fail(c, "INVALID_INPUT", "marketId is required (no order with this id is on record)");
      if (!ownerMatches(c, owner)) return fail(c, "UNAUTHORIZED", "The signature does not belong to this owner.");
      const venue = marketId.split(":")[0] as VenueId;
      const a = await agentOf(deps.db, agentRef, owner);
      if (a === null || a === "retired") return refuseBuild(c, deps, "RETIRED_AGENT", { owner, agentRef, venue, marketId, body });
      if (a === "killed") return refuseBuild(c, deps, "AGENT_KILLED", { owner, agentRef, venue, marketId, body });
      const adapter = deps.adapters.get(a.venue);
      if (!adapter || a.venue !== venue) return fail(c, "INVALID_INPUT", "The market is not on this agent's venue.");
      const requestHash = sha256Jcs(body);
      const b = await adapter.buildCancel({ marketId, ...(venueOrderId ? { venueOrderId } : {}), ...(clientOrderId ? { clientOrderId } : {}) }, buildCtx(c, a, STANDARD_FEE, { policyId: null, mode: "relay", requestHash, nowMs: deps.now(), closing: true }));
      await store(deps, b, a, "cancel", { mode: "relay", requestHash, policyId: null, leverage: 1, intent: null });
      return c.json(b);
    },
  };

  const closeAllRoute: RouteSpec = {
    method: "POST",
    path: "/orders/close-all/build",
    auth: "owner_sig",
    authAlt: ["api_key"],
    description: "Build reduce-only close payloads for every position of your active agents",
    write: { action: "order", venue: (_c, body) => ((body as { venues?: string[] } | null)?.venues?.[0] as string | undefined) ?? "hyperliquid" },
    async handler(c) {
      const body = await json(c);
      const parsed = CloseAllBuildZ.safeParse(body);
      if (!parsed.success) return fail(c, "INVALID_INPUT", issues(parsed.error));
      const deps = await getDeps();
      const owner = parsed.data.owner as Hex;
      if (!ownerMatches(c, owner)) return fail(c, "UNAUTHORIZED", "The signature does not belong to this owner.");
      const venues = parsed.data.venues as VenueId[] | undefined;
      const rows = await deps.db.select().from(schema.delegations).where(and(eq(schema.delegations.owner, owner.toLowerCase()), eq(schema.delegations.state, "active")));
      const requestHash = sha256Jcs(body);
      const out: UnsignedVenuePayload[] = [];
      const unavailable: { venue: VenueId; reason: string }[] = [];
      for (const d of rows) {
        const venue = d.venue as VenueId;
        if (venues && !venues.includes(venue)) continue;
        const a = await agentOf(deps.db, d.id, owner);
        const adapter = deps.adapters.get(venue);
        if (!a || typeof a === "string" || !adapter?.buildCloseAll) {
          unavailable.push({ venue, reason: "close-all is not available for this venue here" });
          continue;
        }
        for (const b of await adapter.buildCloseAll(a.identity, buildCtx(c, a, STANDARD_FEE, { policyId: null, mode: "relay", requestHash, nowMs: deps.now(), closing: true }))) {
          if (!b.preview.reduceOnly) throw new CapstanError("INTERNAL_ERROR", "a close-all build must be reduce-only");
          await store(deps, b, a, "close", { mode: "relay", requestHash, policyId: null, leverage: 1, intent: null });
          out.push(b);
        }
      }
      return c.json({ builds: out, unavailable });
    },
  };

  const submitRoute: RouteSpec = {
    method: "POST",
    path: "/orders/submit",
    auth: "owner_sig",
    authAlt: ["api_key"],
    description: "Submit a signed envelope through the relay",
    write: {
      action: "order",
      venue: (_c, body) => ((body as { signedEnvelope?: { venue?: string } } | null)?.signedEnvelope?.venue as string | undefined) ?? null,
      // the edge decides for the build's owner and market (the body carries only the build id)
      async marketId(c, body) {
        const id = (body as { buildId?: unknown } | null)?.buildId;
        if (typeof id !== "string") return null;
        const deps = await getDeps();
        const [r] = await deps.db.select({ marketId: schema.orderBuilds.marketId, owner: schema.orderBuilds.owner }).from(schema.orderBuilds).where(eq(schema.orderBuilds.id, id)).limit(1);
        if (!r) return null;
        // the edge decides for the owner; the agent's own state (killed, retired, expired) is the relay's check,
        // which answers with the precise code
        if (ctxGet(c, "owner") === undefined) ctxSet(c, "owner", r.owner);
        return r.marketId;
      },
    },
    async handler(c) {
      const body = await json(c);
      const parsed = OrderSubmitZ.safeParse(body);
      if (!parsed.success) return fail(c, "INVALID_INPUT", issues(parsed.error));
      const deps = await getDeps();
      const [row] = await deps.db.select({ owner: schema.orderBuilds.owner, intent: schema.orderBuilds.intent }).from(schema.orderBuilds).where(eq(schema.orderBuilds.id, parsed.data.buildId)).limit(1);
      if (row && !ownerMatches(c, row.owner as Hex)) return fail(c, "UNAUTHORIZED", "The signature does not belong to this owner.");
      const apiKeyId = ctxGet(c, "apiKeyId") as string | undefined;
      const kind = (row?.intent as { kind?: BuildKind } | undefined)?.kind ?? "order";
      const priority: Priority = kind === "order" ? await deps.laneOf((row?.owner ?? "0x0000000000000000000000000000000000000000") as Hex, apiKeyId) : "safety";
      const ip = deps.ipOf ? deps.ipOf(c) : (clientIp(c, process.env.CAPSTAN_TRUST_FORWARDED_FOR === "1") ?? "");
      const r = await deps.relay.submit({ buildId: parsed.data.buildId, signedEnvelope: parsed.data.signedEnvelope as never, ip, ...(apiKeyId ? { apiKey: apiKeyId } : {}) }, priority, ulid());
      if ("queued" in r) return c.json({ status: "queued", buildId: parsed.data.buildId }, 202);
      if (!r.ok) return c.json(r.body, r.status as 400);
      return c.json(r.result);
    },
  };
  return [buildRoute, cancelRoute, closeAllRoute, submitRoute];
}

let resolved: Promise<OrdersRouteDeps> | null = null;

/** Wiring from the environment (the api holds no receipt key: receipts go through the receipt-sign worker). */
export async function ordersEnvDeps(): Promise<OrdersRouteDeps> {
  return (resolved ??= (async () => {
    const env = process.env;
    if (!env.DATABASE_URL || !env.REDIS_URL) throw new CapstanError("INTERNAL_ERROR", "order routes need DATABASE_URL and REDIS_URL");
    const db = createDb(env.DATABASE_URL, { max: 6 });
    const redis = createRedis(env.REDIS_URL);
    const bull = createRedis(env.REDIS_URL, { forBullmq: true });
    const { getAdapters } = await import("../adapters");
    const { adapters } = await getAdapters();
    const receipts = queuedReceipts(bull, db);
    const relayStore = pgRelayStore(db);
    const { createGovernor } = await import("@capstan/venue-client");
    const policy = dbPolicySource(db);
    const claimDeps: ClaimDeps = { store: relayStore, venues: await relayVenues(env, createGovernor(redis, env.RELAY_EGRESS_ID ?? "local")), receipts, policy, flags: relayFlags(env), kill: memoryKillView(), now: Date.now, id: () => ulid() };
    const { Queue } = await import("bullmq");
    const alertsQ = new Queue("alerts-dispatch", { connection: bull, prefix: "capstan" });
    const { tierOf, dbWalletActivity, limitsFor } = await import("@capstan/plans");
    const lock = { lockedOf: async () => ({ amount: 0n, unlockAt: 0n }) };
    const tier = async (owner: Hex, apiKeyId?: string) => tierOf(apiKeyId ? { apiKeyId, owner } : { owner }, { db, lock, cacheTtlMs: 60_000, activity: dbWalletActivity(db) }).catch(() => null);
    return {
      db,
      adapters,
      relay: relayQueueClient(bull),
      claim: (req) => handleClaim(req, claimDeps),
      policy,
      usage: relayStore.agentUsage,
      issue: async (d) => ({ receiptId: (await receipts.issue(d)).receiptId }),
      alerts: { policyBreach: async (e) => void (await alertsQ.add("alerts-dispatch", { source: "policy_breach", owner: e.owner.toLowerCase(), agentRef: e.agentRef, field: e.field }, { removeOnComplete: 1000, removeOnFail: 5000 })) },
      feeOf: async (owner, apiKeyId) => (await tier(owner, apiKeyId))?.builderFee ?? STANDARD_FEE,
      laneOf: async (owner, apiKeyId) => {
        const t = await tier(owner, apiKeyId);
        return t ? limitsFor(t.tier, { newWallet: t.newWallet }).relayLane : "free";
      },
      isExecutable: async (marketId) => {
        const [m] = await db.select({ executable: schema.markets.executable }).from(schema.markets).where(eq(schema.markets.id, marketId)).limit(1);
        return m?.executable === true;
      },
      now: Date.now,
    } satisfies OrdersRouteDeps;
  })());
}

export const routes: RouteSpec[] = createOrderRoutes(() => ordersEnvDeps());
export type { StoredBuild };
