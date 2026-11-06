// Nightly market sync. Sync can only make a market LESS executable: new markets and new dexes enter with
// executable = false, and only a review (reviewEquivalence or setExecutable) can turn a market on.
// - A market missing from its venue's listing becomes 'delisted' (row kept, so open positions still show).
// - A HIP-3 dex that disappears from perpDexs turns every market in it 'reduce_only' and non-executable.
// - A source that throws is reported and skipped: its markets are not touched (never delisted by an outage).
// - Running twice on the same inputs changes nothing and the second report is empty.
import type { Db } from "@capstan/core";
import { ulid } from "@capstan/core";
import { db as schema, type CanonicalAsset, type Market, type VenueId } from "@capstan/schema";
import { and, eq, inArray } from "drizzle-orm";
import { proposeCanonical } from "./propose";

export interface MarketSource {
  venue: VenueId;
  listMarkets(): Promise<Market[]>;
  listDexes?(): Promise<{ dex: string; index: number; liveMarkets: number }[]>;
}

export type SyncReport = {
  added: string[];
  updated: string[];
  delisted: string[];
  reduceOnly: string[];
  newDexes: string[];
  aliasProposals: string[];
  errors: { venue: VenueId; message: string }[];
};

export const DATA_ONLY_VENUES: readonly VenueId[] = ["variational", "arcus"];
/** The only HIP-3 dexes that can ever become executable, and only by review. */
export const REVIEWABLE_DEXES: readonly string[] = ["xyz", "io", "para"];

export function emptyReport(): SyncReport {
  return { added: [], updated: [], delisted: [], reduceOnly: [], newDexes: [], aliasProposals: [], errors: [] };
}

type MarketRow = typeof schema.markets.$inferSelect;
type MarketInsert = typeof schema.markets.$inferInsert;

/** Fields sync owns (compared to decide whether a row changed). canonicalAsset and executable are handled apart. */
function rowFields(m: Market) {
  return {
    venue: m.venue,
    dex: m.dex,
    venueSymbol: m.venueSymbol,
    marketType: m.marketType,
    collateralAsset: m.collateralAsset,
    tickSize: m.tickSize,
    lotSize: m.lotSize,
    minNotional: m.minNotional,
    maxLeverage: m.maxLeverage,
    marginModes: [...m.marginModes].sort(),
    fundingIntervalS: m.fundingIntervalS,
    fundingSettleIntervalS: m.fundingSettleIntervalS,
    sessionHours: m.sessionHours ?? null,
    oiCapUsd: m.oiCapUsd,
    builderFeeUnit: m.builderFeeUnit,
    deployerFeeScale: m.deployerFeeScale ?? null,
    growthMode: m.growthMode ?? null,
    venueIndex: m.venueIndex ?? null,
    assetClassHint: m.assetClassHint ?? null,
    contractMultiplier: m.contractMultiplier ?? "1",
    oracleSource: m.oracleSource ?? null,
    dataFreshness: m.dataFreshness,
    status: m.status,
  };
}

const numEq = (a: unknown, b: unknown) => (a === null || a === undefined || b === null || b === undefined ? a == b : Number(a) === Number(b));
const NUMERIC = new Set(["tickSize", "lotSize", "minNotional", "oiCapUsd", "deployerFeeScale", "contractMultiplier", "maxLeverage"]);

function changedFields(row: MarketRow, next: ReturnType<typeof rowFields>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(next)) {
    const cur = (row as Record<string, unknown>)[k];
    if (NUMERIC.has(k) ? !numEq(cur, v) : JSON.stringify(k === "marginModes" ? [...((cur as string[]) ?? [])].sort() : (cur ?? null)) !== JSON.stringify(v ?? null)) out.push(k);
  }
  return out;
}

/** May this market ever be executable (before any review)? */
export function executableAllowedByShape(m: { venue: string; dex: string | null; marketType: string; status: string }): boolean {
  if (DATA_ONLY_VENUES.includes(m.venue as VenueId)) return false;
  if (m.marketType !== "perp") return false;
  if (m.status !== "active") return false;
  if (m.dex !== null && !REVIEWABLE_DEXES.includes(m.dex)) return false;
  return true;
}

async function ensureVenue(db: Db, venue: VenueId): Promise<void> {
  await db
    .insert(schema.venues)
    .values({ id: venue, execution: !DATA_ONLY_VENUES.includes(venue), caps: { venue, canWithdraw: false }, status: "active" })
    .onConflictDoNothing();
}

export async function ensureCanonicalAsset(db: Db, asset: CanonicalAsset): Promise<void> {
  const [cls, ...rest] = asset.split(":");
  await db
    .insert(schema.canonicalAssets)
    .values({ id: asset, class: cls!, displayName: rest.join(":") })
    .onConflictDoNothing();
}

async function syncDexes(db: Db, src: MarketSource, dexes: { dex: string; index: number; liveMarkets: number }[], now: Date, report: SyncReport): Promise<Set<string>> {
  const existing = await db.select().from(schema.dexes).where(eq(schema.dexes.venue, src.venue));
  const listed = new Map(dexes.map((d) => [d.dex, d]));
  const gone = new Set<string>();
  for (const d of dexes) {
    const row = existing.find((e) => e.dex === d.dex);
    if (!row) {
      await db.insert(schema.dexes).values({ venue: src.venue, dex: d.dex, dexIndex: d.index, liveMarkets: d.liveMarkets, status: "active", executable: false, firstSeenAt: now, lastSeenAt: now });
      report.newDexes.push(d.dex);
    } else if (row.status !== "active" || row.dexIndex !== d.index || row.liveMarkets !== d.liveMarkets) {
      // a dex that comes back stays non-executable until reviewed again
      await db
        .update(schema.dexes)
        .set({ status: "active", dexIndex: d.index, liveMarkets: d.liveMarkets, lastSeenAt: now, ...(row.status !== "active" ? { executable: false } : {}) })
        .where(and(eq(schema.dexes.venue, src.venue), eq(schema.dexes.dex, d.dex)));
    }
  }
  for (const row of existing) {
    if (listed.has(row.dex) || row.status === "gone") {
      if (row.status === "gone") gone.add(row.dex);
      continue;
    }
    gone.add(row.dex);
    await db
      .update(schema.dexes)
      .set({ status: "gone", executable: false, lastSeenAt: now })
      .where(and(eq(schema.dexes.venue, src.venue), eq(schema.dexes.dex, row.dex)));
    const affected = await db
      .select({ id: schema.markets.id, status: schema.markets.status })
      .from(schema.markets)
      .where(and(eq(schema.markets.venue, src.venue), eq(schema.markets.dex, row.dex)));
    const toFlip = affected.filter((a) => a.status !== "reduce_only" && a.status !== "delisted").map((a) => a.id);
    if (toFlip.length) {
      await db.update(schema.markets).set({ status: "reduce_only", executable: false, updatedAt: now, lastSeenAt: now }).where(inArray(schema.markets.id, toFlip));
      report.reduceOnly.push(...toFlip);
    }
  }
  return gone;
}

async function syncSource(db: Db, src: MarketSource, now: Date, report: SyncReport): Promise<void> {
  // read everything first, so a failing source changes nothing
  const markets = await src.listMarkets();
  const dexList = src.listDexes ? await src.listDexes() : null;
  for (const m of markets) if (m.venue !== src.venue) throw new Error(`source ${src.venue} returned a market of ${m.venue}`);

  await ensureVenue(db, src.venue);
  const goneDexes = dexList ? await syncDexes(db, src, dexList, now, report) : new Set<string>();
  const rows = await db.select().from(schema.markets).where(eq(schema.markets.venue, src.venue));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();

  for (const raw of markets) {
    const m: Market = { ...raw, status: raw.dex !== null && goneDexes.has(raw.dex) ? "reduce_only" : raw.status };
    seen.add(m.id);
    const next = rowFields(m);
    const row = byId.get(m.id);
    const proposal = proposeCanonical(m);
    if (!row) {
      if (proposal.auto && proposal.asset) await ensureCanonicalAsset(db, proposal.asset);
      const ins: MarketInsert = {
        id: m.id,
        ...next,
        canonicalAsset: proposal.auto ? proposal.asset : null,
        executable: false, // always: only a review turns a market on
        lastSeenAt: now,
        updatedAt: now,
      };
      await db.insert(schema.markets).values(ins);
      report.added.push(m.id);
    } else {
      const changed = changedFields(row, next);
      const mustDisable = row.executable && !executableAllowedByShape(next);
      const mapNow = row.canonicalAsset === null && proposal.auto && proposal.asset ? proposal.asset : null;
      if (changed.length || mustDisable || mapNow) {
        if (mapNow) await ensureCanonicalAsset(db, mapNow);
        await db
          .update(schema.markets)
          .set({ ...next, ...(mustDisable ? { executable: false } : {}), ...(mapNow ? { canonicalAsset: mapNow } : {}), updatedAt: now, lastSeenAt: now })
          .where(eq(schema.markets.id, m.id));
        if (next.status === "delisted" && row.status !== "delisted") report.delisted.push(m.id);
        else if (next.status === "reduce_only" && row.status !== "reduce_only") report.reduceOnly.push(m.id);
        else report.updated.push(m.id);
      }
    }
    // alias proposals for review (never for auto-mapped majors); the unique index keeps this idempotent
    if (proposal.asset && !proposal.auto) {
      const inserted = await db
        .insert(schema.marketAliases)
        .values({ id: ulid(now.getTime()), marketId: m.id, canonicalAsset: proposal.asset, status: "proposed", auto: false, reason: proposal.reason, createdAt: now })
        .onConflictDoNothing()
        .returning({ id: schema.marketAliases.id });
      if (inserted.length) report.aliasProposals.push(`${m.id} -> ${proposal.asset}`);
    }
  }

  // markets missing from this listing: delisted (rows kept); markets of a gone dex are reduce_only instead
  for (const r of rows) {
    if (seen.has(r.id) || r.status === "delisted") continue;
    if (r.dex !== null && goneDexes.has(r.dex)) continue;
    await db.update(schema.markets).set({ status: "delisted", executable: false, updatedAt: now, lastSeenAt: now }).where(eq(schema.markets.id, r.id));
    report.delisted.push(r.id);
  }
}

export async function syncMarkets(db: Db, sources: MarketSource[], now: Date): Promise<SyncReport> {
  const report = emptyReport();
  for (const src of sources) {
    try {
      // one transaction per source, and its report lines only count once it commits
      const part = emptyReport();
      await db.transaction(async (tx) => {
        await syncSource(tx as unknown as Db, src, now, part);
      });
      for (const k of ["added", "updated", "delisted", "reduceOnly", "newDexes", "aliasProposals"] as const) report[k].push(...part[k]);
    } catch (e) {
      report.errors.push({ venue: src.venue, message: (e as Error).message.slice(0, 300) });
    }
  }
  for (const k of ["added", "updated", "delisted", "reduceOnly", "newDexes", "aliasProposals"] as const) report[k].sort();
  return report;
}
