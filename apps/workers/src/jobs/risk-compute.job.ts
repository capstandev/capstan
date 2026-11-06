// risk-compute, every 5 minutes (spec 9 risk-aggregator): for every owner with open routed positions, build the risk
// view (each venue's own account and liquidation price, fixed banner), write risk_snapshots, publish the change on
// PUBSUB.risk(owner) and a liquidation-distance event for each position within 10% of its own venue's liquidation
// price (user alerts read these). Owners come from routed orders of the last 30 days; an owner whose view has no open
// position gets no row. It never places, closes or changes anything.
import { createQueue, PUBSUB, schema, type Db, type JobDef } from "@capstan/core";
import { enqueueAlertWork } from "../alerts/producers";
import { dbCatalogReader } from "@capstan/quote";
import { cacheMarks, dbIdentities, ownerView, type CapstanRiskView, type LadderRow, type OwnerViewDeps } from "@capstan/risk";
import type { Hex } from "@capstan/schema";
import { and, desc, eq, gte } from "drizzle-orm";
import { workerAccounts } from "./risk-refresh.job";

export const RISK_COMPUTE_EVERY_MS = 5 * 60_000;
export const OWNER_LOOKBACK_MS = 30 * 86_400_000;
export const LIQ_EVENT_PCT = 10;

export interface RiskComputeDeps {
  db: Db;
  view: (owner: Hex) => Promise<CapstanRiskView>;
  publish?: (channel: string, payload: unknown) => Promise<void>;
  /** Liquidation-distance hook for the user alerts (alerts-dispatch). */
  onView?: (owner: Hex, view: CapstanRiskView) => Promise<void>;
  now: () => Date;
}

export async function ownersWithRoutedOrders(db: Db, now: Date): Promise<Hex[]> {
  const rows = await db.selectDistinct({ owner: schema.orders.owner }).from(schema.orders).where(gte(schema.orders.submittedAt, new Date(now.getTime() - OWNER_LOOKBACK_MS)));
  return [...new Set(rows.map((r) => r.owner.toLowerCase()))].sort() as Hex[];
}

export interface RiskDelta {
  kind: "delta";
  owner: string;
  asOf: string;
  changed: LadderRow[];
  closed: string[];
}

/** Ladder rows that are new or whose distance moved by 0.1 points or more, and positions no longer open. */
export function riskDelta(prev: CapstanRiskView | null, next: CapstanRiskView): RiskDelta {
  const key = (r: LadderRow) => `${r.venue}|${r.marketId}`;
  const before = new Map((prev?.liquidationLadder ?? []).map((r) => [key(r), r]));
  const changed = next.liquidationLadder.filter((r) => {
    const b = before.get(key(r));
    if (!b) return true;
    if ((b.distancePct === null) !== (r.distancePct === null)) return true;
    return b.distancePct !== null && r.distancePct !== null && Math.abs(b.distancePct - r.distancePct) >= 0.1;
  });
  const now = new Set(next.liquidationLadder.map(key));
  const closed = [...before.keys()].filter((k) => !now.has(k)).map((k) => k.split("|")[1]!);
  return { kind: "delta", owner: (next.owner ?? "").toLowerCase(), asOf: next.asOf, changed, closed };
}

export async function runRiskCompute(d: RiskComputeDeps): Promise<{ owners: number; written: number; events: number }> {
  const now = d.now();
  const owners = await ownersWithRoutedOrders(d.db, now);
  let written = 0;
  let events = 0;
  for (const owner of owners) {
    let view: CapstanRiskView;
    try {
      view = await d.view(owner);
    } catch {
      continue; // one owner's failed read never stops the others
    }
    if (!view.perVenue.some((s) => s.positions.length > 0)) continue;
    const [last] = await d.db.select().from(schema.riskSnapshots).where(eq(schema.riskSnapshots.owner, owner)).orderBy(desc(schema.riskSnapshots.ts)).limit(1);
    await d.db.insert(schema.riskSnapshots).values({ ts: now, owner, view }).onConflictDoUpdate({ target: [schema.riskSnapshots.owner, schema.riskSnapshots.ts], set: { view } });
    written++;
    const delta = riskDelta((last?.view as CapstanRiskView | undefined) ?? null, view);
    await d.publish?.(PUBSUB.risk(owner), delta);
    for (const r of view.liquidationLadder) {
      if (r.distancePct === null || r.distancePct > LIQ_EVENT_PCT) continue;
      await d.publish?.(PUBSUB.risk(owner), { kind: "liq_distance", owner, marketId: r.marketId, venue: r.venue, distancePct: r.distancePct, liqPx: r.liqPx, markPx: r.markPx, asOf: view.asOf });
      events++;
    }
    await d.onView?.(owner, view);
  }
  return { owners: owners.length, written, events };
}

/** Rows older than this are not needed by the heatmap or the dashboard. */
export async function latestSnapshot(db: Db, owner: Hex, since: Date): Promise<CapstanRiskView | null> {
  const [r] = await db.select().from(schema.riskSnapshots).where(and(eq(schema.riskSnapshots.owner, owner.toLowerCase()), gte(schema.riskSnapshots.ts, since))).orderBy(desc(schema.riskSnapshots.ts)).limit(1);
  return (r?.view as CapstanRiskView | undefined) ?? null;
}

let alertQueue: ReturnType<typeof createQueue> | null = null;

export const job: JobDef = {
  name: "risk-compute",
  queue: "riskCompute",
  schedule: { every: RISK_COMPUTE_EVERY_MS },
  concurrency: 1,
  async handler(_j, deps) {
    if (!deps.db) throw new Error("risk-compute needs a database");
    const db = deps.db;
    const vd: OwnerViewDeps = { identities: dbIdentities(db), accounts: await workerAccounts(deps), catalog: dbCatalogReader(db), marks: deps.cache ? cacheMarks(deps.cache) : async () => new Map(), now: () => deps.now().getTime() };
    const alerts = deps.redis ? (alertQueue ??= createQueue("alertsDispatch", deps.redis)) : null;
    const onView = alerts ? async (owner: Hex, v: CapstanRiskView) => enqueueAlertWork(alerts, { source: "risk", owner, ladder: v.liquidationLadder.filter((x) => x.distancePct !== null && x.distancePct <= LIQ_EVENT_PCT).map((x) => ({ marketId: x.marketId, venue: x.venue, distancePct: x.distancePct, liqPx: x.liqPx, markPx: x.markPx })) }) : undefined;
    const r = await runRiskCompute({ db, view: (o) => ownerView(o, vd), publish: deps.publish, now: deps.now, ...(onView ? { onView } : {}) });
    deps.log.info("risk-compute", r);
    return r;
  },
};
