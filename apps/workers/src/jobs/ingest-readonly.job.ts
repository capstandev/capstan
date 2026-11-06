// Read-only venue ingest (Variational and Arcus), every 10 s. Both are data-only cross-check feeds: they are never
// best in a quote and never execute. Each tick takes one Arcus markets snapshot (about 2.4 weight per second) and the
// Variational snapshot (the adapter refetches at most every 30 s), writes marks and funding to the market data cache,
// and appends history rows to mark_ticks and funding_ticks with source 'venue'. Variational rows keep the venue's
// real asOf (its quote updated_at), never the fetch time, so a delayed value never looks fresh.
import { defaultArcusAdapter, type ArcusAdapter } from "@capstan/adapter-arcus";
import { defaultVariationalAdapter, type VariationalAdapter } from "@capstan/adapter-variational";
import type { Db, JobDef, JobDeps, MarketDataCache } from "@capstan/core";
import { db as schema, type FundingSnapshot } from "@capstan/schema";

export const INGEST_READONLY_EVERY_MS = 10_000;
const CHUNK = 500;

export interface MarkRow {
  marketId: string;
  mark: string;
  index?: string | null;
  oiUsd?: string | null;
  asOf: string;
}

export interface ReadonlySnapshotSource {
  venue: "variational" | "arcus";
  snapshot(): Promise<{ marks: MarkRow[]; funding: FundingSnapshot[]; fetchedAt: number }>;
}

export interface ReadonlyIngestReport {
  venues: { venue: string; marks: number; funding: number; error?: string }[];
  markRows: number;
  fundingRows: number;
}

/** Arcus data carries no venue timestamp: its history rows are bucketed to the fetch minute (one row per minute). */
export function minuteOf(iso: string): Date {
  const t = Date.parse(iso);
  return new Date(t - (t % 60_000));
}

export async function writeTicks(db: Db, venue: ReadonlySnapshotSource["venue"], marks: MarkRow[], funding: FundingSnapshot[]): Promise<{ markRows: number; fundingRows: number }> {
  const mrows = marks.map((m) => ({ ts: venue === "arcus" ? minuteOf(m.asOf) : new Date(m.asOf), marketId: m.marketId, mark: m.mark, index: m.index ?? null, oiUsd: m.oiUsd ?? null }));
  const frows = funding.map((f) => ({
    ts: venue === "arcus" ? minuteOf(f.asOf) : new Date(f.asOf),
    marketId: f.marketId,
    ratePerInterval: f.ratePerInterval,
    intervalS: f.intervalS,
    ratePerHour: f.ratePerHour,
    predictedNext: f.predictedNext,
    source: "venue",
  }));
  let markRows = 0;
  let fundingRows = 0;
  for (let i = 0; i < mrows.length; i += CHUNK) {
    const r = await db.insert(schema.markTicks).values(mrows.slice(i, i + CHUNK)).onConflictDoNothing().returning({ id: schema.markTicks.marketId });
    markRows += r.length;
  }
  for (let i = 0; i < frows.length; i += CHUNK) {
    const r = await db.insert(schema.fundingTicks).values(frows.slice(i, i + CHUNK)).onConflictDoNothing().returning({ id: schema.fundingTicks.marketId });
    fundingRows += r.length;
  }
  return { markRows, fundingRows };
}

export async function runReadonlyIngest(sources: ReadonlySnapshotSource[], cache: MarketDataCache | null, db: Db | null): Promise<ReadonlyIngestReport> {
  const report: ReadonlyIngestReport = { venues: [], markRows: 0, fundingRows: 0 };
  for (const s of sources) {
    try {
      const snap = await s.snapshot();
      if (cache) {
        for (const m of snap.marks) await cache.putMark(m.marketId, m.mark, m.asOf);
        for (const f of snap.funding) await cache.putFunding(f);
      }
      if (db) {
        const w = await writeTicks(db, s.venue, snap.marks, snap.funding);
        report.markRows += w.markRows;
        report.fundingRows += w.fundingRows;
      }
      report.venues.push({ venue: s.venue, marks: snap.marks.length, funding: snap.funding.length });
    } catch (e) {
      // one venue down never stops the other
      report.venues.push({ venue: s.venue, marks: 0, funding: 0, error: (e as Error).message.slice(0, 200) });
    }
  }
  return report;
}

export function readonlySources(v: Pick<VariationalAdapter, "snapshot">, a: Pick<ArcusAdapter, "snapshot">): ReadonlySnapshotSource[] {
  return [
    { venue: "variational", snapshot: () => v.snapshot() },
    { venue: "arcus", snapshot: () => a.snapshot() },
  ];
}

let wired: ReadonlySnapshotSource[] | null = null;
function sourcesFor(deps: JobDeps): ReadonlySnapshotSource[] {
  return (wired ??= readonlySources(defaultVariationalAdapter({ redis: deps.redis, cache: deps.cache }), defaultArcusAdapter({ redis: deps.redis, cache: deps.cache })));
}

export const job: JobDef = {
  name: "ingest-readonly",
  queue: "fundingTick",
  schedule: { every: INGEST_READONLY_EVERY_MS },
  concurrency: 1,
  async handler(_job, deps) {
    const r = await runReadonlyIngest(sourcesFor(deps), deps.cache, deps.db);
    const errs = r.venues.filter((v) => v.error);
    if (errs.length) deps.log.warn("ingest-readonly venue error", { errors: errs });
    return r;
  },
};
