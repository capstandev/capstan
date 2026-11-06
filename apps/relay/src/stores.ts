// Relay storage. order_builds keeps the adapter's build as returned (payload) and the build facts the relay re-checks
// (intent column: { intent, kind, mode, requestHash, policyId, leverage }); orders carries the unique payload hash
// that dedupes submits. Delegations are public data only.
import { schema, type Db } from "@capstan/core";
import type { Hex, OrderIntent, UnsignedVenuePayload, VenueId } from "@capstan/schema";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { BuildKind, DelegationView, NewOrderRow, RelayStore, StoredBuild } from "./types";

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
  };
}

const dayStart = (ms: number) => new Date(ms - (ms % 86_400_000));

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
    async insertOrder(row: NewOrderRow) {
      const r = await db.insert(o).values(row).onConflictDoNothing({ target: o.signedPayloadHash }).returning({ id: o.id });
      return r.length === 1;
    },
    async updateOrder(id, patch) {
      await db.update(o).set({ status: patch.status, ...(patch.venueOrderId !== undefined ? { venueOrderId: patch.venueOrderId } : {}) }).where(eq(o.id, id));
    },
    async releaseOrder(id) {
      await db.delete(o).where(eq(o.id, id));
    },
    async agentUsage(agentRef, nowMs) {
      // conservative: every non-reduce-only order the venue accepted (or may have) today counts as open notional
      const rows = await db
        .select({ preview: schema.orderBuilds.preview, status: o.status })
        .from(o)
        .innerJoin(schema.orderBuilds, eq(o.buildId, schema.orderBuilds.id))
        .where(and(eq(schema.orderBuilds.agentRef, agentRef), gte(o.submittedAt, dayStart(nowMs)), inArray(o.status, ["pending", "accepted", "unknown"])));
      let gross = 0;
      let count = 0;
      for (const r of rows) {
        count++;
        const p = r.preview as { notionalUsd?: string; reduceOnly?: boolean };
        if (!p.reduceOnly) gross += Number(p.notionalUsd ?? 0);
      }
      return { grossNotionalUsd: gross.toFixed(2), ordersToday: count };
    },
  };
}

/** Same contract in memory (unit tests, the local stack). */
export function memoryRelayStore(): RelayStore & { builds: Map<string, StoredBuild>; delegations: Map<string, DelegationView>; orders: Map<string, NewOrderRow & { venueOrderId?: string | null }> } {
  const builds = new Map<string, StoredBuild>();
  const delegations = new Map<string, DelegationView>();
  const orders = new Map<string, NewOrderRow & { venueOrderId?: string | null }>();
  const byHash = new Map<string, string>();
  return {
    builds,
    delegations,
    orders,
    getBuild: async (id) => builds.get(id) ?? null,
    getDelegation: async (ref) => delegations.get(ref) ?? null,
    async insertOrder(row) {
      if (byHash.has(row.signedPayloadHash)) return false;
      byHash.set(row.signedPayloadHash, row.id);
      orders.set(row.id, { ...row });
      return true;
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
    async agentUsage(agentRef, nowMs) {
      let gross = 0;
      let count = 0;
      for (const r of orders.values()) {
        const b = builds.get(r.buildId);
        if (!b || b.agentRef !== agentRef || r.submittedAt.getTime() < dayStart(nowMs).getTime() || !["pending", "accepted", "unknown"].includes(r.status)) continue;
        count++;
        if (!b.build.preview.reduceOnly) gross += Number(b.build.preview.notionalUsd);
      }
      return { grossNotionalUsd: gross.toFixed(2), ordersToday: count };
    },
  };
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
