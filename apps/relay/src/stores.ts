// Relay storage. order_builds keeps the adapter's build as returned (payload) and the build facts the relay re-checks
// (intent column: { intent, kind, mode, requestHash, policyId, leverage }); orders carries the unique payload hash
// that dedupes submits. Delegations are public data only.
import { schema, type Db } from "@capstan/core";
import type { Hex, OrderIntent, RiskView, UnsignedVenuePayload, VenueId } from "@capstan/schema";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { AgentUsage, BuildKind, DelegationView, GrossSince, NewOrderRow, RelayStore, StoredBuild } from "./types";

export interface BuildFacts {
  intent: OrderIntent | null;
  kind: BuildKind;
  mode: "relay" | "direct";
  requestHash: Hex;
  policyId: string | null;
  leverage: number;
}

export const isUniqueViolation = (e: unknown): boolean => {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.code === "23505" || x?.cause?.code === "23505";
};

/** Write one build row (the api build routes call this). */
export async function saveBuild(db: Db, b: { build: UnsignedVenuePayload; owner: Hex; agentRef: string | null; facts: BuildFacts }): Promise<void> {
  await db.insert(schema.orderBuilds).values({
    id: b.build.buildId,
    owner: b.owner.toLowerCase(),
    agentRef: b.agentRef,
    venue: b.build.venue,
    marketId: b.build.preview.marketId,
    intent: b.facts,
    // stored as JSON text: jsonb reorders object keys, and venue encodings (HL msgpack) depend on key order
    payload: JSON.stringify(b.build),
    digest: b.build.digest,
    preview: b.build.preview,
    eligibilityDecisionId: b.build.eligibilityDecisionId,
    expiresAt: new Date(b.build.expiresAt),
  });
}

function toStored(r: typeof schema.orderBuilds.$inferSelect): StoredBuild {
  const f = r.intent as BuildFacts;
  return {
    build: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as UnsignedVenuePayload,
    owner: r.owner as Hex,
    agentRef: r.agentRef,
    venue: r.venue as VenueId,
    marketId: r.marketId,
    kind: f.kind,
    mode: f.mode,
    requestHash: f.requestHash,
    policyId: f.policyId,
    leverage: f.leverage,
    eligibilityDecisionId: r.eligibilityDecisionId,
    expiresAt: r.expiresAt.getTime(),
    resting: f.kind === "order" ? isResting(f.intent) : false,
  };
}

const dayStart = (ms: number) => new Date(ms - (ms % 86_400_000));

type Tx = Pick<Db, "select" | "insert">;

/** Resting-capable from the stored facts: a limit order that is not IOC; no facts counts as resting. */
export const isResting = (i: OrderIntent | null | undefined): boolean => !i || (i.type !== "market" && i.tif !== "ioc");

async function pgAgentUsage(db: Tx, agentRef: string, nowMs: number, w: GrossSince): Promise<AgentUsage> {
  const o = schema.orders;
  const b = schema.orderBuilds;
  const f = schema.fills;
  const day = dayStart(nowMs);
  const since = new Date(Math.min(w.sinceMs, w.restingSinceMs, day.getTime()));
  const sinceTs = new Date(w.sinceMs).toISOString();
  const notional = sql`(${b.preview}->>'notionalUsd')::numeric`;
  const resting = sql`(coalesce(${b.intent}->>'kind', 'order') = 'order' and coalesce(${b.intent}->'intent'->>'type', 'limit') <> 'market' and coalesce(${b.intent}->'intent'->>'tif', 'gtc') <> 'ioc')`;
  // the size a fill before the window start shows done (that part is in the positions read)
  const filled = sql`(select coalesce(sum(${f.sz}), 0) from ${f} where ${f.ts} < ${sinceTs}::timestamptz and (${f.orderId} = ${o.id} or (${f.venue} = ${o.venue} and ${f.venueOrderId} = ${o.venueOrderId})))`;
  const left = sql`greatest(0, 1 - coalesce(${filled} / nullif((${b.preview}->>'size')::numeric, 0), 0))`;
  // conservative: every opening order the venue accepted (or may have) since sinceMs counts as open notional until a
  // fresher positions read replaces it, and a resting order counts until a fill shows it done (security r1 R1-06:
  // nothing resets at 00:00 UTC, and a positions read never shows a resting order)
  const [r] = await db
    .select({
      gross: sql<string>`coalesce(sum(case when ${o.submittedAt} >= ${sinceTs}::timestamptz then ${notional} when ${resting} and ${o.submittedAt} >= ${new Date(w.restingSinceMs).toISOString()}::timestamptz then ${notional} * ${left} else 0 end) filter (where coalesce((${b.preview}->>'reduceOnly')::boolean, false) = false), 0)::text`,
      today: sql<number>`(count(*) filter (where ${o.submittedAt} >= ${day.toISOString()}::timestamptz))::int`,
    })
    .from(o)
    .innerJoin(b, eq(o.buildId, b.id))
    .where(and(eq(b.agentRef, agentRef), gte(o.submittedAt, since), inArray(o.status, ["pending", "accepted", "unknown"])));
  return { grossNotionalUsd: Number(r?.gross ?? 0).toFixed(2), ordersToday: Number(r?.today ?? 0) };
}

async function pgInsertOrder(db: Tx, row: NewOrderRow): Promise<boolean> {
  const o = schema.orders;
  const r = await db.insert(o).values(row).onConflictDoNothing({ target: o.signedPayloadHash }).returning({ id: o.id });
  return r.length === 1;
}

/** A per-key async lock in this process (memory store; the pg store uses an advisory lock). */
function keyedLock() {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

export function pgRelayStore(db: Db): RelayStore {
  const o = schema.orders;
  return {
    async getBuild(id) {
      const [r] = await db.select().from(schema.orderBuilds).where(eq(schema.orderBuilds.id, id)).limit(1);
      return r ? toStored(r) : null;
    },
    async getDelegation(ref) {
      const [d] = await db.select().from(schema.delegations).where(eq(schema.delegations.id, ref)).limit(1);
      if (!d) return null;
      return { id: d.id, venue: d.venue as VenueId, owner: d.owner as Hex, agentAddress: (d.agentAddress as Hex | null) ?? null, accountIndex: d.accountIndex, apiKeyIndex: d.apiKeyIndex, state: d.state as DelegationView["state"], expiresAt: d.expiresAt ? d.expiresAt.getTime() : null };
    },
    insertOrder: (row: NewOrderRow) => pgInsertOrder(db, row),
    async orderByHash(h) {
      const [r] = await db.select({ id: o.id, buildId: o.buildId, status: o.status, venueOrderId: o.venueOrderId }).from(o).where(eq(o.signedPayloadHash, h)).limit(1);
      return r ?? null;
    },
    async updateOrder(id, patch) {
      await db.update(o).set({ status: patch.status, ...(patch.venueOrderId !== undefined ? { venueOrderId: patch.venueOrderId } : {}) }).where(eq(o.id, id));
    },
    async releaseOrder(id) {
      await db.delete(o).where(eq(o.id, id));
    },
    async unsettledOrders(from, to, limit) {
      const rows = await db
        .select({ id: o.id, buildId: o.buildId, venue: o.venue, signedPayloadHash: o.signedPayloadHash, status: o.status, venueOrderId: o.venueOrderId, submittedAt: o.submittedAt })
        .from(o)
        .where(and(eq(o.mode, "relay"), inArray(o.status, ["pending", "unknown"]), gte(o.submittedAt, from), lte(o.submittedAt, to)))
        .orderBy(o.submittedAt)
        .limit(limit);
      return rows.map((r) => ({ ...r, venue: r.venue as VenueId, signedPayloadHash: r.signedPayloadHash as Hex }));
    },
    agentUsage: (agentRef, nowMs, since) => pgAgentUsage(db, agentRef, nowMs, since),
    async reserveAgentOrder(row, agentRef, nowMs, since, check) {
      // one transaction per reservation: the advisory lock serialises every relay process's reservations for this
      // agent, so the usage read and the pending row are one step
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agent-usage:${agentRef}`}, 0))`);
        const r = check(await pgAgentUsage(tx, agentRef, nowMs, since));
        if (!r.ok) return { ok: false, reason: "policy", field: r.field } as const;
        return (await pgInsertOrder(tx, row)) ? ({ ok: true } as const) : ({ ok: false, reason: "duplicate" } as const);
      });
    },
  };
}

/** Same contract in memory (unit tests, the local stack). */
export function memoryRelayStore(): RelayStore & { builds: Map<string, StoredBuild>; delegations: Map<string, DelegationView>; orders: Map<string, NewOrderRow & { venueOrderId?: string | null }>; fills: { venue: VenueId; venueOrderId: string; sz: string; ts: number }[] } {
  const builds = new Map<string, StoredBuild>();
  const delegations = new Map<string, DelegationView>();
  const orders = new Map<string, NewOrderRow & { venueOrderId?: string | null }>();
  const byHash = new Map<string, string>();
  /** Fills the reconcile workers record (venue order id, size, time). */
  const fills: { venue: VenueId; venueOrderId: string; sz: string; ts: number }[] = [];
  const lock = keyedLock();
  const store: RelayStore & { builds: typeof builds; delegations: typeof delegations; orders: typeof orders; fills: typeof fills } = {
    builds,
    delegations,
    orders,
    fills,
    getBuild: async (id) => builds.get(id) ?? null,
    getDelegation: async (ref) => delegations.get(ref) ?? null,
    async insertOrder(row) {
      if (byHash.has(row.signedPayloadHash)) return false;
      byHash.set(row.signedPayloadHash, row.id);
      orders.set(row.id, { ...row });
      return true;
    },
    async orderByHash(h) {
      const id = byHash.get(h);
      const r = id ? orders.get(id) : undefined;
      return r ? { id: r.id, buildId: r.buildId, status: r.status, venueOrderId: r.venueOrderId ?? null } : null;
    },
    async updateOrder(id, patch) {
      const r = orders.get(id);
      if (r) orders.set(id, { ...r, ...patch });
    },
    async releaseOrder(id) {
      const r = orders.get(id);
      if (r) byHash.delete(r.signedPayloadHash);
      orders.delete(id);
    },
    async unsettledOrders(from, to, limit) {
      return [...orders.values()]
        .filter((r) => r.mode === "relay" && (r.status === "pending" || r.status === "unknown") && r.submittedAt >= from && r.submittedAt <= to)
        .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime())
        .slice(0, limit)
        .map((r) => ({ id: r.id, buildId: r.buildId, venue: r.venue, signedPayloadHash: r.signedPayloadHash, status: r.status, venueOrderId: r.venueOrderId ?? null, submittedAt: r.submittedAt }));
    },
    async agentUsage(agentRef, nowMs, w) {
      let gross = 0;
      let count = 0;
      for (const r of orders.values()) {
        const b = builds.get(r.buildId);
        if (!b || b.agentRef !== agentRef || !["pending", "accepted", "unknown"].includes(r.status)) continue;
        const t = r.submittedAt.getTime();
        if (t >= dayStart(nowMs).getTime()) count++;
        if (b.build.preview.reduceOnly) continue;
        const n = Number(b.build.preview.notionalUsd);
        if (t >= w.sinceMs) gross += n;
        else if (b.kind === "order" && b.resting !== false && t >= w.restingSinceMs) {
          const done = fills.filter((x) => x.ts < w.sinceMs && x.venue === r.venue && r.venueOrderId && x.venueOrderId === r.venueOrderId).reduce((m, x) => m + Number(x.sz), 0);
          const size = Number(b.build.preview.size);
          gross += n * Math.max(0, 1 - (size > 0 ? done / size : 0));
        }
      }
      return { grossNotionalUsd: gross.toFixed(2), ordersToday: count };
    },
    reserveAgentOrder: (row, agentRef, nowMs, since, check) =>
      lock(agentRef, async () => {
        const r = check(await store.agentUsage(agentRef, nowMs, since));
        if (!r.ok) return { ok: false, reason: "policy", field: r.field } as const;
        return (await store.insertOrder(row)) ? ({ ok: true } as const) : ({ ok: false, reason: "duplicate" } as const);
      }),
  };
  return store;
}

/** A risk snapshot older than this is not used for the gross cap (risk-compute writes one every 5 minutes). */
export const EXPOSURE_FRESH_MS = 10 * 60_000;

/**
 * The positions read behind one venue entry of a stored risk view, or null when it is not a safety input (security r2
 * R2-RELAY-01). A 'client_read' entry is whatever the caller posted to /v1/risk/ingest in direct mode: only the query
 * signature is checked, never the answer, and the policed agent itself can post it. So only reads the server made
 * count. Aster entries must say who read the positions ('positionsSource', set by the positionRisk ingest) and that it
 * was the relay; a later balance read moves 'source' and 'asOf' but not the positions, so 'positionsAsOf' is the time.
 * Venues read server side from public account endpoints (Hyperliquid, Lighter) carry no source and count as before.
 */
export function positionsRead(snap: { venue: VenueId; asOf: string; source?: unknown; positionsSource?: unknown; positionsAsOf?: unknown }): { asOf: string } | null {
  if (snap.venue === "aster" || snap.source !== undefined || snap.positionsSource !== undefined) {
    if (snap.positionsSource !== "relay_read" || typeof snap.positionsAsOf !== "string") return null;
    return { asOf: snap.positionsAsOf };
  }
  return { asOf: snap.asOf };
}

/**
 * Open exposure from risk_snapshots (security r1 R1-06): the owner's newest snapshot within EXPOSURE_FRESH_MS, summed
 * over that venue's positions. Owner-level, so other agents' positions on the account count too (over-counting only
 * refuses earlier). Null when there is no fresh snapshot or the venue is missing from it; the relay then counts every
 * opening order since the policy was issued.
 */
export function dbExposure(db: Db): import("./types").ExposureSource {
  return {
    async openGrossUsd(owner, venue, nowMs) {
      const [r] = await db
        .select({ view: schema.riskSnapshots.view })
        .from(schema.riskSnapshots)
        .where(and(eq(schema.riskSnapshots.owner, owner.toLowerCase()), gte(schema.riskSnapshots.ts, new Date(nowMs - EXPOSURE_FRESH_MS))))
        .orderBy(desc(schema.riskSnapshots.ts))
        .limit(1);
      return exposureFromView(r?.view as RiskView | undefined, venue, nowMs);
    },
  };
}

/** One venue's open gross from a stored risk view, or null when it is missing, stale or not a safety input. */
export function exposureFromView(view: RiskView | undefined, venue: VenueId, nowMs: number): { grossUsd: string; asOfMs: number } | null {
  const snap = view?.perVenue?.find((p) => p.venue === venue);
  if (!snap) return null;
  const read = positionsRead(snap);
  if (!read) return null;
  const asOfMs = Date.parse(read.asOf);
  if (!Number.isFinite(asOfMs) || nowMs - asOfMs > EXPOSURE_FRESH_MS) return null;
  const gross = snap.positions.reduce((n, p) => n + Math.abs(Number(p.notionalUsd)), 0);
  if (!Number.isFinite(gross)) return null;
  return { grossUsd: gross.toFixed(2), asOfMs };
}

/** Venue-signal refusals (spec 10 input 4) cached per owner and venue for 24 h. */
export function memoryVenueSignals(ttlMs = 86_400_000) {
  const m = new Map<string, number>();
  const k = (o: Hex, v: VenueId) => `${o.toLowerCase()}:${v}`;
  return {
    async get(o: Hex, v: VenueId, now: number) {
      const t = m.get(k(o, v));
      return t !== undefined && now - t < ttlMs;
    },
    async put(o: Hex, v: VenueId, now: number) {
      m.set(k(o, v), now);
    },
  };
}

export function redisVenueSignals(redis: { get(k: string): Promise<string | null>; set(k: string, v: string, px: "PX", ms: number): Promise<unknown> }, ttlMs = 86_400_000) {
  const k = (o: Hex, v: VenueId) => `relay:geo-signal:${o.toLowerCase()}:${v}`;
  return {
    async get(o: Hex, v: VenueId) {
      try {
        return (await redis.get(k(o, v))) !== null;
      } catch {
        return false; // the main eligibility check still runs (and fails closed on its own)
      }
    },
    async put(o: Hex, v: VenueId, now: number) {
      await redis.set(k(o, v), String(now), "PX", ttlMs);
    },
  };
}
