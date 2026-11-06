// Shared parts of the builder-fee reconciler (spec 9, F4): the report shape, decimal sums, receipt and order lookups,
// fill and accrual writes (idempotent), and the ops alert. Fills and accruals are per venue; nothing is netted.
import { recordBuilderFee } from "@capstan/telemetry";
import { schema, type Db } from "@capstan/core";
import { Dec, type Hex, type VenueId } from "@capstan/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

export const OPS_ALERT_CHANNEL = "ops.alert";
export const ALERT_KIND = "reconciler.mismatch";
export const DAY_MS = 86_400_000;
const SCALE = 18;

export interface ReconReport {
  day: string;
  venue: VenueId;
  fills: number;
  notionalUsd: string;
  feeUsd: string;
  unmatchedFills: string[];
  receiptsWithoutFill: string[];
  csvCrossCheck?: { rows: number; feeUsd: string; status: "ok" | "pending_lag" | "missing_403" | "diff"; day?: string; unmatchedRows?: number; malformed?: number };
  /** Owners whose venue read failed; the others still ran (per-owner isolation). */
  failedOwners?: string[];
  /** Owners past the per-run cap, left for the next run. */
  ownersSkipped?: number;
  /** Fills with a builder fee on orders Capstan has no record of (another builder, or ours: the CSV pass decides). */
  foreignFills?: number;
  /** Venue part skipped on this host, with the reason. */
  skipped?: string;
  /** Fee rows in an asset with no USD value (not summed). */
  nonUsdFeeRows?: number;
}

export type Publish = (channel: string, payload: unknown) => Promise<void>;

export const d = (s: string): Dec => Dec.parse(s, SCALE, "half_even");
export const zero = (): Dec => d("0");
export const str = (x: Dec): string => Dec.toString(x);

export function dayBounds(day: string): { start: number; end: number; compact: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`reconcile: day must be YYYY-MM-DD, got ${day}`);
  const start = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== day) throw new Error(`reconcile: bad day ${day}`);
  return { start, end: start + DAY_MS, compact: day.replaceAll("-", "") };
}

export const shiftDay = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const previousUtcDay = (now: Date): string => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS).toISOString().slice(0, 10);

export async function alert(publish: Publish | undefined, log: { warn(m: string, f?: Record<string, unknown>): void } | undefined, detail: Record<string, unknown>): Promise<void> {
  const event = { kind: ALERT_KIND, severity: "warn", detail };
  if (publish) await publish(OPS_ALERT_CHANNEL, event);
  log?.warn("reconciler mismatch", detail);
}

export interface ReceiptRef {
  id: string;
  owner: string | null;
  marketId: string | null;
  venueOrderId: string;
  ts: Date;
}

const ORDER_ACTIONS = ["order.submit", "order.claim"];

/** order.submit / order.claim receipts that name one of these venue order ids. */
export async function receiptsFor(db: Db, venue: VenueId, oids: string[]): Promise<Map<string, ReceiptRef>> {
  const out = new Map<string, ReceiptRef>();
  const t = schema.receipts;
  for (let i = 0; i < oids.length; i += 500) {
    const chunk = oids.slice(i, i + 500);
    const rows = await db
      .select({ id: t.id, owner: t.owner, body: t.body, ts: t.ts })
      .from(t)
      .where(and(inArray(t.action, ORDER_ACTIONS), sql`${t.body}->>'venue' = ${venue}`, inArray(sql`${t.body}->>'venueOrderId'`, chunk)));
    for (const r of rows) {
      const b = r.body as { venueOrderId?: string; marketId?: string | null };
      if (b.venueOrderId) out.set(b.venueOrderId, { id: r.id, owner: r.owner, marketId: b.marketId ?? null, venueOrderId: b.venueOrderId, ts: r.ts });
    }
  }
  return out;
}

export type OrderRow = typeof schema.orders.$inferSelect;

export async function ordersFor(db: Db, venue: VenueId, oids: string[]): Promise<Map<string, OrderRow>> {
  const out = new Map<string, OrderRow>();
  const t = schema.orders;
  for (let i = 0; i < oids.length; i += 500) {
    const rows = await db
      .select()
      .from(t)
      .where(and(eq(t.venue, venue), inArray(t.venueOrderId, oids.slice(i, i + 500))));
    for (const r of rows) if (r.venueOrderId) out.set(r.venueOrderId, r);
  }
  return out;
}

export interface FillRow {
  id: string;
  orderId: string | null;
  venue: VenueId;
  venueOrderId: string;
  px: string;
  sz: string;
  feeUsd: string; // the venue's own part, without the builder fee
  builderFeeUsd: string;
  ts: Date;
}

/** Insert fills; a fill id seen before is updated in place (a re-run never doubles a fill). */
export async function upsertFills(db: Db, fills: FillRow[]): Promise<void> {
  const t = schema.fills;
  for (let i = 0; i < fills.length; i += 500) {
    const chunk = fills.slice(i, i + 500);
    if (!chunk.length) continue;
    await db
      .insert(t)
      .values(chunk)
      .onConflictDoUpdate({ target: t.id, set: { orderId: sql`excluded.order_id`, px: sql`excluded.px`, sz: sql`excluded.sz`, feeUsd: sql`excluded.fee_usd`, builderFeeUsd: sql`excluded.builder_fee_usd`, ts: sql`excluded.ts` } });
  }
}

export interface Accrual {
  day: string;
  venue: VenueId;
  builder: Hex;
  fills: number;
  notionalUsd: string;
  feeUsd: string;
  unmatchedFills: number;
  source: "hl_userfills" | "aster_commissions";
}

/** One row per (day, venue, builder): a re-run replaces it. */
export async function upsertAccrual(db: Db, a: Accrual): Promise<void> {
  const t = schema.builderFeeAccruals;
  const row = { ...a, builder: a.builder.toLowerCase() };
  const [prev] = await db.select({ feeUsd: t.feeUsd }).from(t).where(and(eq(t.day, row.day), eq(t.venue, row.venue), eq(t.builder, row.builder))).limit(1);
  await db
    .insert(t)
    .values(row)
    .onConflictDoUpdate({ target: [t.day, t.venue, t.builder], set: { fills: row.fills, notionalUsd: row.notionalUsd, feeUsd: row.feeUsd, unmatchedFills: row.unmatchedFills, source: row.source } });
  // the fee counter moves by what this run added (a re-run of the same day adds nothing)
  const delta = Number(row.feeUsd) - Number(prev?.feeUsd ?? 0);
  if (Number.isFinite(delta) && delta > 0) recordBuilderFee(row.venue, delta);
}

/**
 * Receipts for orders that the venue marks filled or partial, issued that day, with no fill on record for the order:
 * "receipt without fill".
 */
export async function receiptsWithoutFill(db: Db, venue: VenueId, start: number, end: number): Promise<string[]> {
  const r = schema.receipts;
  const o = schema.orders;
  const f = schema.fills;
  const rows = await db
    .select({ id: r.id })
    .from(r)
    .innerJoin(o, and(eq(o.venue, venue), sql`${o.venueOrderId} = ${r.body}->>'venueOrderId'`))
    .where(
      and(
        inArray(r.action, ORDER_ACTIONS),
        sql`${r.body}->>'venue' = ${venue}`,
        sql`${r.ts} >= ${new Date(start).toISOString()}::timestamptz and ${r.ts} < ${new Date(end).toISOString()}::timestamptz`,
        inArray(o.status, ["filled", "partial"]),
        sql`not exists (select 1 from ${f} where ${f.venue} = ${venue} and ${f.venueOrderId} = ${o.venueOrderId})`,
      ),
    );
  return [...new Set(rows.map((x) => x.id))].sort();
}
