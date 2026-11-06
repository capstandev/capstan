// Spread plan routes (spec 13.1, E5): funding-rate spread trades (at-risk). Legging risk is yours.
// POST /v1/spreads/plan           a draft plan (ack required); the server never executes it
// POST /v1/spreads/{id}/ack       the owner's (or an active agent's) spread_ack signature over ACK_TEXT(planId)
// POST /v1/spreads/{id}/events    the client executor's step events, cross-checked against venue reads, with receipts
// GET  /v1/spreads/{id}           plan and events
// plan, events and GET serve only the plan's owner: the owner_sig signer must be that owner or one of its active agents.
// Each publishes on PUBSUB.plan(id). Nothing here moves collateral, nets margin or rebalances.
import { createDb, createMarketDataCache, createQueue, createRedis, PUBSUB, redisNonceStore, schema, type Db, type NonceStore, type RouteSpec } from "@capstan/core";
import { activePolicyFor } from "@capstan/policy";
import { cachedDepegReader, type QuoteAdapter } from "@capstan/quote";
import { drafts } from "@capstan/receipts";
import { ack, dbPlanStore, dbSpreadCatalog, PlanError, plan, recordEvent, type EventDeps, type EventLog, type PlanDeps, type PlanStore, type ReceiptPort, type SpreadEventKind } from "@capstan/spreads";
import { Dec, errorBody, SpreadAckZ, SpreadEventZ, SpreadPlanZ, type Hex, type VenueId } from "@capstan/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { enqueueAlertWork } from "@capstan/workers/src/alerts/producers";
import { queuedReceiptIssuer, type ReceiptIssuer } from "./agents.routes";

export interface SpreadRouteDeps {
  planDeps: PlanDeps;
  store: PlanStore & EventLog;
  events: Omit<EventDeps, "store" | "events" | "now">;
  nonces: NonceStore;
  host: string;
  agentsOf(owner: Hex): Promise<Hex[]>;
  publish?: (channel: string, payload: unknown) => Promise<void>;
  /** User alerts: an unhedged plan end goes to the alerts-dispatch queue. */
  onPlanEvent?: (x: { planId: string; owner: Hex; kind: SpreadEventKind; status: string; data: unknown }) => Promise<void>;
  now?: () => number;
}

const STATUS: Record<PlanError["code"], number> = { NOT_APPROVED: 403, VENUE_DATA_ONLY: 403, NO_PAIR: 409, INVALID_INPUT: 400, NOT_FOUND: 404, BAD_ACK: 401, BAD_STATE: 409 };
const CODE = { NOT_APPROVED: "MARKET_NOT_EXECUTABLE", VENUE_DATA_ONLY: "VENUE_DATA_ONLY", NO_PAIR: "STALE_QUOTE", INVALID_INPUT: "INVALID_INPUT", NOT_FOUND: "NOT_FOUND", BAD_ACK: "UNAUTHORIZED", BAD_STATE: "INVALID_INPUT" } as const;

function planErr(c: Context, e: unknown): Response {
  if (e instanceof PlanError) return c.json(errorBody(CODE[e.code], e.message), STATUS[e.code] as 400);
  throw e;
}

async function json(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const ctxGet = (c: Context, k: string): unknown => (c as unknown as { get(k: string): unknown }).get(k);

/**
 * The owner_sig gate sets `owner` to the owner the signature was made for (by that owner or one of its active
 * agents). A plan is served only to its owner: anyone else's valid signature is refused (fail closed when unset).
 */
function signedForOwner(c: Context, owner: string): boolean {
  const authed = ctxGet(c, "owner");
  return typeof authed === "string" && authed.toLowerCase() === owner.toLowerCase();
}
const notOwner = (c: Context) => c.json(errorBody("UNAUTHORIZED", "The signature does not belong to this plan's owner."), 401);

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; ");

/** spread.leg / spread.plan receipts through the receipt issuer (checked drafts from packages/receipts). */
export function receiptPort(issuer: ReceiptIssuer): ReceiptPort {
  return {
    async issue(action, input) {
      const draft = action === "spread.leg" ? drafts.spreadLeg(input as never) : drafts.spreadPlan(input as never);
      return issuer.issue(draft);
    },
  };
}

export function createSpreadRoutes(getDeps: () => Promise<SpreadRouteDeps> | SpreadRouteDeps): RouteSpec[] {
  return [
    {
      method: "POST",
      path: "/spreads/plan",
      auth: "owner_sig",
      description: "Plan a funding-rate spread trade (at-risk; legging risk is yours). The plan must be acknowledged before it runs on your side",
      async handler(c) {
        const body = await json(c);
        if (!body) return c.json(errorBody("INVALID_INPUT", "body must be a JSON object"), 400);
        const p = SpreadPlanZ.safeParse(body);
        if (!p.success) return c.json(errorBody("INVALID_INPUT", issues(p.error)), 400);
        if (!signedForOwner(c, p.data.owner)) return notOwner(c);
        const deps = await getDeps();
        const extra = {
          ...(Array.isArray(body.marketIds) && body.marketIds.length === 2 && body.marketIds.every((x) => typeof x === "string") ? { marketIds: body.marketIds as [string, string] } : {}),
          ...(Number.isInteger(body.maxLegSlippageBps) && (body.maxLegSlippageBps as number) >= 0 && (body.maxLegSlippageBps as number) <= 500 ? { maxLegSlippageBps: body.maxLegSlippageBps as number } : {}),
          ...(Number.isInteger(body.legTimeoutMs) && (body.legTimeoutMs as number) >= 500 && (body.legTimeoutMs as number) <= 60_000 ? { legTimeoutMs: body.legTimeoutMs as number } : {}),
        };
        try {
          const sp = await plan({ ...p.data, owner: p.data.owner as Hex, ...extra }, deps.planDeps);
          await deps.publish?.(PUBSUB.plan(sp.planId), { planId: sp.planId, status: sp.status });
          return c.json(sp);
        } catch (e) {
          return planErr(c, e);
        }
      },
    },
    {
      method: "POST",
      path: "/spreads/:id/ack",
      auth: "owner_sig",
      description: "Acknowledge a spread plan with your wallet or your agent key",
      async handler(c) {
        const id = c.req.param("id") ?? "";
        const body = await json(c);
        if (!body) return c.json(errorBody("INVALID_INPUT", "body must be a JSON object"), 400);
        const a = SpreadAckZ.safeParse(body);
        if (!a.success || typeof body.message !== "string" || body.message.length > 2000) return c.json(errorBody("INVALID_INPUT", a.success ? "message: the signed acknowledgement text is required" : issues(a.error)), 400);
        const deps = await getDeps();
        const by = typeof body.by === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.by) ? (body.by as Hex) : null;
        try {
          const r = await ack(id, a.data.sig as Hex, by, { store: deps.store, nonces: deps.nonces, host: deps.host, nowMs: (deps.now ?? Date.now)(), agentsOf: deps.agentsOf, message: body.message });
          await deps.publish?.(PUBSUB.plan(id), { planId: id, status: r.status });
          return c.json(r);
        } catch (e) {
          return planErr(c, e);
        }
      },
    },
    {
      method: "POST",
      path: "/spreads/:id/events",
      auth: "owner_sig",
      description: "Report a step of a spread plan run on your side",
      async handler(c) {
        const id = c.req.param("id") ?? "";
        const body = await json(c);
        if (!body) return c.json(errorBody("INVALID_INPUT", "body must be a JSON object"), 400);
        const ev = SpreadEventZ.safeParse(body);
        if (!ev.success) return c.json(errorBody("INVALID_INPUT", issues(ev.error)), 400);
        const deps = await getDeps();
        const owned = await deps.store.get(id);
        if (!owned) return c.json(errorBody("NOT_FOUND", "Unknown plan."), 404);
        if (!signedForOwner(c, owned.owner)) return notOwner(c);
        try {
          const r = await recordEvent(id, { kind: ev.data.kind as SpreadEventKind, data: ev.data.data, ...(ev.data.signedPayloadHash ? { signedPayloadHash: ev.data.signedPayloadHash as Hex } : {}) }, { ...deps.events, store: deps.store, events: deps.store, now: () => new Date((deps.now ?? Date.now)()) });
          if (deps.onPlanEvent) {
            const sp = await deps.store.get(id);
            if (sp) await deps.onPlanEvent({ planId: id, owner: sp.owner, kind: ev.data.kind as SpreadEventKind, status: r.status, data: ev.data.data }).catch(() => undefined);
          }
          return c.json(r);
        } catch (e) {
          return planErr(c, e);
        }
      },
    },
    {
      method: "GET",
      path: "/spreads/:id",
      auth: "owner_sig",
      description: "A spread plan and its events",
      async handler(c) {
        const id = c.req.param("id") ?? "";
        const deps = await getDeps();
        const sp = await deps.store.get(id);
        if (!sp) return c.json(errorBody("NOT_FOUND", "Unknown plan."), 404);
        if (!signedForOwner(c, sp.owner)) return notOwner(c);
        return c.json({ plan: sp.plan, owner: sp.owner, events: await deps.store.list(id) });
      },
    },
  ];
}

/** Active secp agent addresses of an owner (HL and Aster agents can sign an ack; Lighter keys cannot). */
export function dbAgentsOf(db: Db): SpreadRouteDeps["agentsOf"] {
  return async (owner) => {
    const rows = await db
      .select({ a: schema.delegations.agentAddress })
      .from(schema.delegations)
      .where(and(sql`lower(${schema.delegations.owner}) = ${owner.toLowerCase()}`, eq(schema.delegations.state, "active"), isNotNull(schema.delegations.agentAddress)));
    return rows.map((r) => r.a as Hex);
  };
}

let resolved: Promise<SpreadRouteDeps> | null = null;

async function envDeps(): Promise<SpreadRouteDeps> {
  const env = process.env;
  if (!env.REDIS_URL || !env.DATABASE_URL) throw new Error("spread routes need REDIS_URL and DATABASE_URL");
  const redis = createRedis(env.REDIS_URL);
  const cache = createMarketDataCache(redis);
  const db = createDb(env.DATABASE_URL, { max: 4 });
  const adapters = new Map<VenueId, QuoteAdapter>();
  for (const v of ["hyperliquid", "lighter-mainnet", "lighter-rh", "aster"] as VenueId[])
    adapters.set(v, {
      caps: { venue: v, execution: true, keyType: v.startsWith("lighter") ? "lighter-native" : "secp256k1", delegation: v.startsWith("lighter") ? "api_key_index" : "agent", canWithdraw: false, builderFee: null, collateral: [], directSubmitSupported: true, publicAccountReads: v !== "aster" },
      getBook: async (id: string) => (await cache.getBook(id)) ?? Promise.reject(new Error(`no cached book for ${id}`)),
      getFunding: async (id: string) => (await cache.getFunding(id)) ?? Promise.reject(new Error(`no cached funding for ${id}`)),
    });
  const store = dbPlanStore(db);
  const alertQueue = createQueue("alertsDispatch", createRedis(env.REDIS_URL, { forBullmq: true }));
  const publish = async (ch: string, payload: unknown) => void (await redis.publish(ch, JSON.stringify(payload)));
  const { emitOpsEvent } = await import("@capstan/telemetry");
  const hl = await import("@capstan/adapter-hyperliquid");
  const rt = hl.createHlRuntime(env, { redis, cache });
  return {
    planDeps: { catalog: dbSpreadCatalog(db), quote: { adapters, cache, depeg: cachedDepegReader(redis) }, funding: { get: (id) => cache.getFunding(id) }, now: () => new Date(), store, eqExecutionAllowed: env.EQ_EXECUTION_ALLOWED === "1" || env.EQ_EXECUTION_ALLOWED === "true" },
    store,
    events: {
      receipts: receiptPort(queuedReceiptIssuer(createQueue("receiptSign", createRedis(env.REDIS_URL, { forBullmq: true })))),
      // Hyperliquid order fills are public (orderStatus by user and oid, master address); other venues' fills need the
      // owner's own signed read, so their events are stored as unverified (mismatch null)
      venueFill: async (venue, oid, owner) => {
        if (venue !== "hyperliquid" || !/^\d{1,15}$/.test(oid)) return null;
        const r = await rt.http.postJson<{ status?: string; order?: { order?: { origSz?: string; sz?: string } } }>("/info", { type: "orderStatus", user: owner.toLowerCase(), oid: Number(oid) });
        const o = r?.order?.order;
        if (r?.status !== "order" || !o?.origSz || !o.sz || !/^\d+(\.\d+)?$/.test(o.origSz) || !/^\d+(\.\d+)?$/.test(o.sz)) return null;
        return { filled: Dec.toString(Dec.sub(Dec.parse(o.origSz, 18), Dec.parse(o.sz, 18))) };
      },
      alert: async (x) => void (await emitOpsEvent(redis as never, { kind: x.kind, severity: "warn", detail: x.detail })),
      publish,
      policyIdFor: async (owner, venue) => {
        const rows = await db.select({ id: schema.delegations.id }).from(schema.delegations).where(and(sql`lower(${schema.delegations.owner}) = ${owner.toLowerCase()}`, eq(schema.delegations.venue, venue)));
        for (const r of rows) {
          const p = await activePolicyFor(db, r.id, owner);
          if (p) return p.policyId;
        }
        return null;
      },
    },
    nonces: redisNonceStore(redis),
    host: env.PUBLIC_API_HOST ?? "localhost:8710",
    agentsOf: dbAgentsOf(db),
    publish,
    onPlanEvent: async (x) => {
      if (x.kind !== "unhedged") return;
      await enqueueAlertWork(alertQueue, { source: "plan", owner: x.owner, planId: x.planId, kind: x.kind, data: (x.data ?? {}) as { residualDeltaBase?: string; reason?: string } });
    },
  };
}

export const routes: RouteSpec[] = createSpreadRoutes(() => (resolved ??= envDeps()));
