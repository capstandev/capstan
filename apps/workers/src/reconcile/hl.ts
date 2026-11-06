// Hyperliquid builder-fee reconciliation for one UTC day (DECISIONS 32). Primary source: `userFillsByTime` per owner
// who routed an HL order (it has `oid`, `hash`, `tid` and `builderFee`). A fill is Capstan's when its `oid` is one of
// our orders or receipts; those fills are stored, joined to receipts, and summed into the day's accrual. userFills
// lists every fill of the user, including fills through other builders, so a fill on an order we have no record of is
// only counted (foreignFills). The builder CSV, which holds our builder's fills only, settles those three days later:
// a CSV row with no stored fill is a fill without a receipt. A missing CSV day (403) is tolerated.
// Reads go through the governor at `free` priority (safety traffic keeps its 20% reserve), one owner at a time, and a
// failing owner never stops the others (KEEP-1). At most RECON_MAX_OWNERS owners per run (KEEP-3/4).
import type { Db } from "@capstan/core";
import { schema } from "@capstan/core";
import type { HlFill, HlReader } from "@capstan/adapter-hyperliquid";
import { Dec, type Hex } from "@capstan/schema";
import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { parseBuilderCsv, ReconError, type CsvFetcher, type HlCsvRow } from "./csv";
import { alert, d, dayBounds, ordersFor, receiptsFor, receiptsWithoutFill, shiftDay, str, upsertAccrual, upsertFills, zero, DAY_MS, type FillRow, type Publish, type ReconReport } from "./common";

export const RECON_MAX_OWNERS = 5_000;
export const HL_FILLS_PAGE = 2_000; // userFillsByTime answers at most 2,000 fills per call
export const HL_MAX_PAGES = 10;
export const CSV_LAG_DAYS = 3;
export const CSV_GIVE_UP_DAYS = 7; // a CSV day still 403 this long after the day is treated as missing
export const CSV_DIFF_PCT = 1;
const OPEN_LOOKBACK_DAYS = 30;

/** Memory of CSV days still waiting for publication. */
export interface CsvState {
  pending(): Promise<string[]>;
  set(day: string, status: "pending_lag" | "done"): Promise<void>;
}

export function memoryCsvState(): CsvState {
  const m = new Map<string, string>();
  return {
    pending: async () => [...m.entries()].filter(([, v]) => v === "pending_lag").map(([k]) => k).sort(),
    set: async (day, s) => void m.set(day, s),
  };
}

export function redisCsvState(redis: { hgetall(k: string): Promise<Record<string, string>>; hset(k: string, f: string, v: string): Promise<unknown>; hdel(k: string, f: string): Promise<unknown> }, builder: Hex): CsvState {
  const key = `capstan:recon:hl-csv:${builder.toLowerCase()}`;
  return {
    pending: async () => Object.entries(await redis.hgetall(key)).filter(([, v]) => v === "pending_lag").map(([k]) => k).sort(),
    async set(day, s) {
      if (s === "done") await redis.hdel(key, day);
      else await redis.hset(key, day, s);
    },
  };
}

export interface HlReconDeps {
  db: Db;
  hl: Pick<HlReader, "userFills">;
  builder: Hex;
  csv: CsvFetcher;
  csvState?: CsvState;
  publish?: Publish;
  log?: { warn(m: string, f?: Record<string, unknown>): void; info?(m: string, f?: Record<string, unknown>): void };
  maxOwners?: number;
  csvMaxBytes?: number;
  /** Clock for the CSV give-up rule; defaults to the end of the day plus one day. */
  now?: () => Date;
}

/** Owners to read: an HL order submitted that day, an order still open or filling from the last 30 days, or an HL receipt that day. */
async function ownersFor(db: Db, start: number, end: number): Promise<string[]> {
  const o = schema.orders;
  const r = schema.receipts;
  const from = new Date(start);
  const to = new Date(end);
  const a = await db
    .selectDistinct({ owner: sql<string>`lower(${o.owner})` })
    .from(o)
    .where(and(eq(o.venue, "hyperliquid"), lt(o.submittedAt, to), or(gte(o.submittedAt, from), and(gte(o.submittedAt, new Date(start - OPEN_LOOKBACK_DAYS * DAY_MS)), inArray(o.status, ["open", "partial"])))));
  const b = await db
    .selectDistinct({ owner: sql<string>`lower(${r.owner})` })
    .from(r)
    .where(and(inArray(r.action, ["order.submit", "order.claim"]), sql`${r.body}->>'venue' = 'hyperliquid'`, gte(r.ts, from), lt(r.ts, to), sql`${r.owner} is not null`));
  return [...new Set([...a, ...b].map((x) => x.owner).filter(Boolean))].sort();
}

async function pageFills(hl: Pick<HlReader, "userFills">, owner: Hex, start: number, end: number): Promise<HlFill[]> {
  const seen = new Set<string>();
  const out: HlFill[] = [];
  let from = start;
  for (let page = 0; page < HL_MAX_PAGES; page++) {
    const fills = await hl.userFills(owner, from, end - 1);
    let last = from;
    for (const f of fills) {
      if (f.time < start || f.time >= end) continue;
      const k = fillId(f);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(f);
      if (f.time > last) last = f.time;
    }
    if (fills.length < HL_FILLS_PAGE || last <= from) break;
    from = last + 1;
  }
  return out;
}

export const fillId = (f: HlFill): string => (f.hash && f.tid !== undefined ? `hl:${f.hash.toLowerCase()}:${f.tid}` : `hl:${f.oid}:${f.time}:${f.px}:${f.sz}`);
const coinOf = (marketId: string | null): string | null => {
  if (!marketId) return null;
  const [v, dex, sym] = marketId.split(":");
  if (v !== "hyperliquid" || !sym) return null;
  return dex === "-" ? sym : `${dex}:${sym}`;
};
const norm = (x: string): string => Dec.toString(d(x));
export const csvKey = (user: string, coin: string, timeMs: number, px: string, sz: string): string => `${user.toLowerCase()}|${coin}|${Math.floor(timeMs / 1000)}|${norm(px)}|${norm(sz)}`;

export async function reconcileHl(day: string, deps: HlReconDeps): Promise<ReconReport> {
  const { start, end } = dayBounds(day);
  const cap = deps.maxOwners ?? RECON_MAX_OWNERS;
  const all = await ownersFor(deps.db, start, end);
  const owners = all.slice(0, cap);
  const report: ReconReport = { day, venue: "hyperliquid", fills: 0, notionalUsd: "0", feeUsd: "0", unmatchedFills: [], receiptsWithoutFill: [], failedOwners: [], ownersSkipped: all.length - owners.length, foreignFills: 0 };

  const byOwner: { owner: string; fills: HlFill[] }[] = [];
  for (const owner of owners) {
    try {
      byOwner.push({ owner, fills: await pageFills(deps.hl, owner as Hex, start, end) });
    } catch (e) {
      report.failedOwners!.push(owner);
      deps.log?.warn("reconcile hl: owner read failed", { owner, error: (e as Error).message });
    }
  }

  const oids = [...new Set(byOwner.flatMap((x) => x.fills.map((f) => String(f.oid))))];
  const [orders, receipts] = await Promise.all([ordersFor(deps.db, "hyperliquid", oids), receiptsFor(deps.db, "hyperliquid", oids)]);
  const rows: FillRow[] = [];
  let notional = zero();
  let fee = zero();
  const missing: { id: string; owner: string; oid: string; builderFee: string }[] = [];
  for (const { owner, fills } of byOwner) {
    for (const f of fills) {
      const oid = String(f.oid);
      const order = orders.get(oid);
      const receipt = receipts.get(oid);
      const bf = f.builderFee ?? "0";
      if (!order && !receipt) {
        if (Dec.cmp(d(bf), zero()) > 0) report.foreignFills!++;
        continue;
      }
      const id = fillId(f);
      // userFills.fee already includes the builder fee: the venue's part is fee - builderFee, subtracted once here
      rows.push({ id, orderId: order?.id ?? null, venue: "hyperliquid", venueOrderId: oid, px: f.px, sz: f.sz, feeUsd: str(Dec.sub(d(f.fee), d(bf))), builderFeeUsd: bf, ts: new Date(f.time) });
      notional = Dec.add(notional, Dec.mul(d(f.px), d(f.sz), 18));
      fee = Dec.add(fee, d(bf));
      if (!receipt) {
        report.unmatchedFills.push(id);
        if (Dec.cmp(d(bf), zero()) > 0) missing.push({ id, owner, oid, builderFee: bf });
      }
    }
  }
  await upsertFills(deps.db, rows);
  report.fills = rows.length;
  report.notionalUsd = str(notional);
  report.feeUsd = str(fee);
  report.unmatchedFills.sort();
  await upsertAccrual(deps.db, { day, venue: "hyperliquid", builder: deps.builder, fills: rows.length, notionalUsd: report.notionalUsd, feeUsd: report.feeUsd, unmatchedFills: report.unmatchedFills.length, source: "hl_userfills" });
  if (missing.length) await alert(deps.publish, deps.log, { day, venue: "hyperliquid", reason: "fill_without_receipt", unmatchedFills: missing.length, fills: missing.slice(0, 20) });

  report.receiptsWithoutFill = await receiptsWithoutFill(deps.db, "hyperliquid", start, end);
  if (report.receiptsWithoutFill.length) await alert(deps.publish, deps.log, { day, venue: "hyperliquid", reason: "receipt_without_fill", unmatchedFills: report.receiptsWithoutFill.length, receipts: report.receiptsWithoutFill.slice(0, 20) });
  if (report.failedOwners!.length) deps.log?.warn("reconcile hl: owners not read", { day, count: report.failedOwners!.length });

  report.csvCrossCheck = await csvPass(day, deps);
  return report;
}

/** Cross-check the CSV for day - 3, plus any earlier day still waiting for publication. Returns the day - 3 result. */
async function csvPass(day: string, deps: HlReconDeps): Promise<ReconReport["csvCrossCheck"]> {
  const state = deps.csvState ?? memoryCsvState();
  const target = shiftDay(day, -CSV_LAG_DAYS);
  const nowMs = (deps.now ?? (() => new Date(dayBounds(day).end + DAY_MS)))().getTime();
  const days = [...new Set([...(await state.pending()), target])].sort();
  let result: ReconReport["csvCrossCheck"];
  for (const csvDay of days) {
    const r = await csvCheck(csvDay, deps, nowMs);
    if (r.status === "pending_lag") await state.set(csvDay, "pending_lag");
    else await state.set(csvDay, "done");
    if (csvDay === target) result = r;
  }
  return result;
}

async function csvCheck(csvDay: string, deps: HlReconDeps, nowMs: number): Promise<NonNullable<ReconReport["csvCrossCheck"]>> {
  const { start, end, compact } = dayBounds(csvDay);
  const got = await deps.csv.get(deps.builder.toLowerCase() as Hex, compact);
  if (got === 403) {
    const age = (nowMs - end) / DAY_MS;
    return { day: csvDay, rows: 0, feeUsd: "0", status: age >= CSV_GIVE_UP_DAYS ? "missing_403" : "pending_lag" };
  }
  // stored fills of that day, keyed like CSV rows; user and coin come from the order, else from the receipt
  const f = schema.fills;
  const o = schema.orders;
  const stored = await deps.db
    .select({ venueOrderId: f.venueOrderId, px: f.px, sz: f.sz, ts: f.ts, builderFeeUsd: f.builderFeeUsd, owner: o.owner, marketId: o.marketId })
    .from(f)
    .leftJoin(o, eq(o.id, f.orderId))
    .where(and(eq(f.venue, "hyperliquid"), gte(f.ts, new Date(start)), lt(f.ts, new Date(end))));
  const needReceipt = stored.filter((s) => !s.owner).map((s) => s.venueOrderId);
  const rc = needReceipt.length ? await receiptsFor(deps.db, "hyperliquid", [...new Set(needReceipt)]) : new Map();
  const keys = new Map<string, number>();
  let apiFee = zero();
  for (const s of stored) {
    apiFee = Dec.add(apiFee, d(String(s.builderFeeUsd)));
    const owner = s.owner ?? rc.get(s.venueOrderId)?.owner ?? null;
    const coin = coinOf(s.marketId ?? rc.get(s.venueOrderId)?.marketId ?? null);
    if (!owner || !coin) continue;
    const k = csvKey(owner, coin, s.ts.getTime(), String(s.px), String(s.sz));
    keys.set(k, (keys.get(k) ?? 0) + 1);
  }
  let csvFee = zero();
  const unmatched: HlCsvRow[] = [];
  const parsed = parseBuilderCsv(got, deps.csvMaxBytes);
  try {
    for await (const row of parsed) {
      csvFee = Dec.add(csvFee, d(row.builderFee));
      const k = csvKey(row.user, row.coin, row.timeMs, row.px, row.sz);
      const n = keys.get(k) ?? 0;
      if (n > 0) keys.set(k, n - 1);
      else unmatched.push(row);
    }
  } catch (e) {
    if (e instanceof ReconError) {
      await alert(deps.publish, deps.log, { day: csvDay, venue: "hyperliquid", reason: "csv_unreadable", code: e.code, unmatchedFills: 0 });
      return { day: csvDay, rows: parsed.stats.rows, feeUsd: str(csvFee), status: "diff", unmatchedRows: 0, malformed: parsed.stats.malformed };
    }
    throw e;
  }
  const big = Dec.cmp(csvFee, apiFee) >= 0 ? csvFee : apiFee;
  const gap = Dec.abs(Dec.sub(csvFee, apiFee));
  const diff = Dec.cmp(Dec.mul(gap, d("100"), 18), Dec.mul(big, d(String(CSV_DIFF_PCT)), 18)) > 0;
  if (unmatched.length) await alert(deps.publish, deps.log, { day: csvDay, venue: "hyperliquid", reason: "csv_fill_without_receipt", unmatchedFills: unmatched.length, rows: unmatched.slice(0, 20).map((r) => ({ user: r.user, coin: r.coin, time: r.time, px: r.px, sz: r.sz, builderFee: r.builderFee })) });
  if (diff) await alert(deps.publish, deps.log, { day: csvDay, venue: "hyperliquid", reason: "csv_fee_diff", csvFeeUsd: str(csvFee), userFillsFeeUsd: str(apiFee), unmatchedFills: unmatched.length });
  return { day: csvDay, rows: parsed.stats.rows, feeUsd: str(csvFee), status: diff ? "diff" : "ok", unmatchedRows: unmatched.length, malformed: parsed.stats.malformed };
}
