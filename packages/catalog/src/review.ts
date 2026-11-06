// Human review: equivalence records (which markets are the same underlying) and the executable flag.
// The spread planner pairs only markets that share an 'approved' equivalence. Approval fails when the contract-spec
// diff has a blocking field, unless an override reason is stored with the review.
// `executable` moves from false to true only here (reviewEquivalence approve, or setExecutable), always with a
// reviewer and notes written to catalog_reviews. Equity-class markets also need the legal flag EQ_EXECUTION_ALLOWED.
import type { Db } from "@capstan/core";
import { ulid } from "@capstan/core";
import { db as schema, type CanonicalAsset, type Market, type VenueId } from "@capstan/schema";
import { and, eq, inArray } from "drizzle-orm";
import { DATA_ONLY_VENUES, ensureCanonicalAsset, executableAllowedByShape, REVIEWABLE_DEXES } from "./sync";

export type Equivalence = typeof schema.equivalences.$inferSelect;
type MarketRow = typeof schema.markets.$inferSelect;

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

export function rowToMarket(r: MarketRow): Market {
  return {
    id: r.id,
    venue: r.venue as VenueId,
    dex: r.dex,
    venueSymbol: r.venueSymbol,
    marketType: r.marketType as Market["marketType"],
    canonicalAsset: (r.canonicalAsset as CanonicalAsset | null) ?? null,
    collateralAsset: r.collateralAsset,
    tickSize: r.tickSize,
    lotSize: r.lotSize,
    minNotional: r.minNotional,
    maxLeverage: r.maxLeverage,
    marginModes: r.marginModes as Market["marginModes"],
    fundingIntervalS: r.fundingIntervalS,
    fundingSettleIntervalS: r.fundingSettleIntervalS,
    sessionHours: (r.sessionHours as Market["sessionHours"]) ?? null,
    oiCapUsd: r.oiCapUsd,
    builderFeeUnit: r.builderFeeUnit as Market["builderFeeUnit"],
    deployerFeeScale: r.deployerFeeScale ?? undefined,
    growthMode: r.growthMode ?? undefined,
    venueIndex: r.venueIndex,
    assetClassHint: (r.assetClassHint as Market["assetClassHint"]) ?? null,
    contractMultiplier: r.contractMultiplier,
    oracleSource: r.oracleSource,
    status: r.status as Market["status"],
    executable: r.executable,
    dataFreshness: r.dataFreshness as Market["dataFreshness"],
    updatedAt: r.updatedAt.toISOString(),
  };
}

export interface SpecDiff {
  field: string;
  a: unknown;
  b: unknown;
  blocking: boolean;
}

/** Contract differences between two markets. Blocking: collateral, contract multiplier, session hours, oracle, type. */
export function contractSpecDiff(a: Market, b: Market): SpecDiff[] {
  const out: SpecDiff[] = [];
  const add = (field: string, x: unknown, y: unknown, blocking: boolean) => out.push({ field, a: x, b: y, blocking });
  if (a.collateralAsset !== b.collateralAsset) add("collateralAsset", a.collateralAsset, b.collateralAsset, true);
  const ma = a.contractMultiplier ?? "1";
  const mb = b.contractMultiplier ?? "1";
  if (Number(ma) !== Number(mb)) add("contractMultiplier", ma, mb, true);
  const sa = a.sessionHours ?? null;
  const sb = b.sessionHours ?? null;
  if (JSON.stringify(sa) !== JSON.stringify(sb)) add("sessionHours", sa === null ? "24/7" : sa, sb === null ? "24/7" : sb, true);
  if (a.oracleSource && b.oracleSource && a.oracleSource !== b.oracleSource) add("oracleSource", a.oracleSource, b.oracleSource, true);
  if (a.marketType !== b.marketType) add("marketType", a.marketType, b.marketType, true);
  if (Number(a.tickSize) !== Number(b.tickSize)) add("tickSize", a.tickSize, b.tickSize, false);
  if (Number(a.lotSize) !== Number(b.lotSize)) add("lotSize", a.lotSize, b.lotSize, false);
  if (a.maxLeverage !== b.maxLeverage) add("maxLeverage", a.maxLeverage, b.maxLeverage, false);
  if (a.fundingIntervalS !== b.fundingIntervalS) add("fundingIntervalS", a.fundingIntervalS, b.fundingIntervalS, false);
  if ([...a.marginModes].sort().join() !== [...b.marginModes].sort().join()) add("marginModes", a.marginModes, b.marginModes, false);
  return out;
}

async function marketsByIds(db: Db, ids: string[]): Promise<MarketRow[]> {
  if (!ids.length) return [];
  const rows = await db.select().from(schema.markets).where(inArray(schema.markets.id, ids));
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw new ReviewError(`unknown market ${missing.join(", ")}`);
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

/** Every pairwise diff of an equivalence's markets. */
export function equivalenceDiffs(markets: Market[]): { a: string; b: string; diffs: SpecDiff[] }[] {
  const out: { a: string; b: string; diffs: SpecDiff[] }[] = [];
  for (let i = 0; i < markets.length; i++)
    for (let j = i + 1; j < markets.length; j++) out.push({ a: markets[i]!.id, b: markets[j]!.id, diffs: contractSpecDiff(markets[i]!, markets[j]!) });
  return out;
}

export async function proposeEquivalence(db: Db, asset: CanonicalAsset, marketIds: string[], notes: string): Promise<string> {
  const ids = [...new Set(marketIds)];
  if (ids.length < 2) throw new ReviewError("an equivalence needs at least two markets");
  await marketsByIds(db, ids);
  await ensureCanonicalAsset(db, asset);
  const id = ulid();
  await db.insert(schema.equivalences).values({ id, canonicalAsset: asset, marketIds: ids, status: "proposed", notes });
  return id;
}

function eqAllowedFromEnv(): boolean {
  return process.env.EQ_EXECUTION_ALLOWED === "1" || process.env.EQ_EXECUTION_ALLOWED === "true";
}

/** Why a market may not be turned on, or null when it may. */
async function executableBlocker(db: Db, r: MarketRow, asset: string | null, eqAllowed: boolean): Promise<string | null> {
  if (DATA_ONLY_VENUES.includes(r.venue as VenueId)) return `${r.venue} is data only`;
  if (!executableAllowedByShape(r)) return `market is ${r.status}, type ${r.marketType}${r.dex ? `, dex ${r.dex}` : ""}: not allowed`;
  if (r.dex !== null) {
    const [d] = await db.select().from(schema.dexes).where(and(eq(schema.dexes.venue, r.venue), eq(schema.dexes.dex, r.dex)));
    if (!d) return `dex ${r.dex} is unknown to the catalog`;
    if (d.status !== "active") return `dex ${r.dex} is ${d.status}`;
    if (!d.executable) return `dex ${r.dex} has not been reviewed (setDexExecutable)`;
  }
  const mapped = asset ?? r.canonicalAsset;
  if (!mapped) return "market has no reviewed canonical asset";
  const cls = mapped.split(":")[0];
  const equityLike = cls !== "CR" || (r.assetClassHint !== null && r.assetClassHint !== "CR");
  if (equityLike && !eqAllowed) return `class ${cls}${r.assetClassHint ? ` (venue states ${r.assetClassHint})` : ""} needs EQ_EXECUTION_ALLOWED`;
  return null;
}

async function writeReview(db: Db, subject: string, change: Record<string, unknown>, reviewer: string, notes: string): Promise<void> {
  await db.insert(schema.catalogReviews).values({ id: ulid(), subject, change, reviewer, notes });
}

function checkReviewer(reviewer: string, notes: string): void {
  if (!reviewer.trim()) throw new ReviewError("a reviewer name is required");
  if (!notes.trim()) throw new ReviewError("review notes are required");
}

/** Reviewed switch of one market's executable flag. Turning on is refused unless every rule passes. */
export async function setExecutable(db: Db, marketId: string, executable: boolean, reviewer: string, notes: string, opts?: { eqExecutionAllowed?: boolean }): Promise<void> {
  checkReviewer(reviewer, notes);
  const [r] = await marketsByIds(db, [marketId]);
  if (executable) {
    const why = await executableBlocker(db, r!, null, opts?.eqExecutionAllowed ?? eqAllowedFromEnv());
    if (why) throw new ReviewError(`${marketId}: ${why}`);
  }
  await db.transaction(async (tx) => {
    await tx.update(schema.markets).set({ executable, updatedAt: new Date() }).where(eq(schema.markets.id, marketId));
    await writeReview(tx as unknown as Db, marketId, { executable }, reviewer, notes);
  });
}

/** Reviewed switch for a HIP-3 dex. Only xyz, io and para can ever be turned on; turning off is always allowed. */
export async function setDexExecutable(db: Db, venue: VenueId, dex: string, executable: boolean, reviewer: string, notes: string): Promise<void> {
  checkReviewer(reviewer, notes);
  const [d] = await db.select().from(schema.dexes).where(and(eq(schema.dexes.venue, venue), eq(schema.dexes.dex, dex)));
  if (!d) throw new ReviewError(`unknown dex ${venue}:${dex}`);
  if (executable) {
    if (!REVIEWABLE_DEXES.includes(dex)) throw new ReviewError(`dex ${dex} can never be executable (only ${REVIEWABLE_DEXES.join(", ")})`);
    if (d.status !== "active") throw new ReviewError(`dex ${dex} is ${d.status}`);
  }
  await db.transaction(async (tx) => {
    await tx.update(schema.dexes).set({ executable }).where(and(eq(schema.dexes.venue, venue), eq(schema.dexes.dex, dex)));
    if (!executable) {
      await tx.update(schema.markets).set({ executable: false, updatedAt: new Date() }).where(and(eq(schema.markets.venue, venue), eq(schema.markets.dex, dex)));
    }
    await writeReview(tx as unknown as Db, `dex:${venue}:${dex}`, { executable }, reviewer, notes);
  });
}

export interface ReviewResult {
  status: "approved" | "rejected";
  executable: string[];
  notExecutable: { marketId: string; why: string }[];
  blocking: SpecDiff[];
}

export async function reviewEquivalence(
  db: Db,
  id: string,
  decision: "approved" | "rejected",
  reviewer: string,
  notes: string,
  opts?: { overrideReason?: string; eqExecutionAllowed?: boolean },
): Promise<ReviewResult> {
  checkReviewer(reviewer, notes);
  const [e] = await db.select().from(schema.equivalences).where(eq(schema.equivalences.id, id));
  if (!e) throw new ReviewError(`unknown equivalence ${id}`);
  if (e.status !== "proposed") throw new ReviewError(`equivalence ${id} is already ${e.status}`);
  if (decision === "rejected") {
    await db.update(schema.equivalences).set({ status: "rejected", reviewer, notes, reviewedAt: new Date() }).where(eq(schema.equivalences.id, id));
    return { status: "rejected", executable: [], notExecutable: [], blocking: [] };
  }
  const rows = await marketsByIds(db, e.marketIds);
  const blocking = equivalenceDiffs(rows.map(rowToMarket)).flatMap((p) => p.diffs.filter((d) => d.blocking).map((d) => ({ ...d, field: `${p.a} vs ${p.b}: ${d.field}` })));
  const override = opts?.overrideReason?.trim();
  if (blocking.length && !override) {
    throw new ReviewError(`blocking contract differences (give an override reason to approve anyway): ${blocking.map((b) => `${b.field} ${JSON.stringify(b.a)} != ${JSON.stringify(b.b)}`).join("; ")}`);
  }
  for (const r of rows) {
    if (r.canonicalAsset && r.canonicalAsset !== e.canonicalAsset) throw new ReviewError(`${r.id} is already mapped to ${r.canonicalAsset}, not ${e.canonicalAsset}`);
  }
  const eqAllowed = opts?.eqExecutionAllowed ?? eqAllowedFromEnv();
  const result: ReviewResult = { status: "approved", executable: [], notExecutable: [], blocking };
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const storedNotes = override ? `${notes}\noverride: ${override}` : notes;
    await t.update(schema.equivalences).set({ status: "approved", reviewer, notes: storedNotes, reviewedAt: new Date() }).where(eq(schema.equivalences.id, id));
    for (const r of rows) {
      const why = await executableBlocker(t, r, e.canonicalAsset, eqAllowed);
      await t
        .update(schema.markets)
        .set({ canonicalAsset: e.canonicalAsset, ...(why ? {} : { executable: true }), updatedAt: new Date() })
        .where(eq(schema.markets.id, r.id));
      await t
        .update(schema.marketAliases)
        .set({ status: "approved", reviewer, notes: storedNotes, reviewedAt: new Date() })
        .where(and(eq(schema.marketAliases.marketId, r.id), eq(schema.marketAliases.canonicalAsset, e.canonicalAsset)));
      if (why) result.notExecutable.push({ marketId: r.id, why });
      else result.executable.push(r.id);
      await writeReview(t, r.id, { canonicalAsset: e.canonicalAsset, executable: !why, equivalence: id }, reviewer, storedNotes);
    }
    await writeReview(t, `equivalence:${id}`, { status: "approved", override: override ?? null, blocking: blocking.length }, reviewer, storedNotes);
  });
  return result;
}

/** Only approved equivalences, ever. */
export async function approvedEquivalences(db: Db, asset?: CanonicalAsset): Promise<Equivalence[]> {
  const where = asset ? and(eq(schema.equivalences.status, "approved"), eq(schema.equivalences.canonicalAsset, asset)) : eq(schema.equivalences.status, "approved");
  return db.select().from(schema.equivalences).where(where).orderBy(schema.equivalences.id);
}

export async function isExecutable(db: Db, marketId: string): Promise<{ ok: boolean; code?: "MARKET_NOT_EXECUTABLE" | "VENUE_DATA_ONLY" }> {
  const [r] = await db.select().from(schema.markets).where(eq(schema.markets.id, marketId));
  if (!r) return { ok: false, code: "MARKET_NOT_EXECUTABLE" };
  if (DATA_ONLY_VENUES.includes(r.venue as VenueId)) return { ok: false, code: "VENUE_DATA_ONLY" };
  if (!r.executable || r.status !== "active" || r.marketType !== "perp") return { ok: false, code: "MARKET_NOT_EXECUTABLE" };
  return { ok: true };
}

/** What waits for a reviewer: proposed equivalences, alias proposals and dexes not yet reviewed. */
export async function pendingReviews(db: Db) {
  const [equivalences, aliases, dexes] = await Promise.all([
    db.select().from(schema.equivalences).where(eq(schema.equivalences.status, "proposed")).orderBy(schema.equivalences.id),
    db.select().from(schema.marketAliases).where(eq(schema.marketAliases.status, "proposed")).orderBy(schema.marketAliases.marketId),
    db.select().from(schema.dexes).where(eq(schema.dexes.executable, false)).orderBy(schema.dexes.venue, schema.dexes.dex),
  ]);
  return { equivalences, aliases, dexes };
}
