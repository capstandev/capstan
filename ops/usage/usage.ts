// Daily usage and the go/no-go thresholds, tracked from day 1 (counts only: no address, account index or IP leaves
// this module). Sources:
//   approvals      venue data: Hyperliquid maxBuilderFee(user, builder) > 0 (public read) and the Aster builder's
//                  approvedUserList (signed builder read, VPS only). The database count is shown next to it and a
//                  delegation the venue does not confirm is flagged, never counted.
//   notional, fee  builder_fee_accruals (reconciled from venue fills) for Hyperliquid and Aster; Capstan fills for both
//                  Lighter configs (routed, 0 fee)
//   x402           x402_payments with status = settled (amounts are 6-decimal token units: USDC and USDG)
//   mcp            request_logs rows of the mcp service with route tools/call (hashed client id)
//   api            request_logs rows of the api service (one per call to a mounted route, hashed client id)
//   refusals       eligibility_decisions with allowed = false, by code
// Thresholds (pre-set): day 14 approvals >= 25, day 30 routed run-rate >= $30M a month, day 60 >= $150M a month.
import type { Db } from "@capstan/core";
import { Dec, db as schema, type Hex } from "@capstan/schema";
import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

export type NotionalVenue = "hl" | "aster" | "lighter304" | "lighterRh";
export const NOTIONAL_VENUES: readonly NotionalVenue[] = ["hl", "aster", "lighter304", "lighterRh"];
const VENUE_KEY: Record<string, NotionalVenue> = { hyperliquid: "hl", aster: "aster", "lighter-mainnet": "lighter304", "lighter-rh": "lighterRh" };

export interface UsageDay {
  day: string;
  approvals: { hl: number; aster: number; union: number };
  routedNotionalUsd: { hl: string; aster: string; lighter304: string; lighterRh: string };
  builderFeeUsd: { hl: string; aster: string };
  x402: { payments: number; usd: string; byRail: Record<string, string> };
  mcp: { calls: number; uniqueClients: number };
  api: { requests: number; uniqueClients: number };
  visitors: number | null;
  refusals: Record<string, number>;
  /** Approvals in our database (delegations) and those the venue does not confirm (flagged, not counted). */
  approvalsDb?: number;
  approvalsFlagged?: number;
  asterApprovalsRead?: boolean;
}

export interface Verdict {
  metric: string;
  value: string | null;
  threshold: string;
  pass: boolean | null; // null = not reached yet or no data
  note: string;
}

// ---------------------------------------------------------------- money: decimal strings at 6 places

export const USD_SCALE = 6;
export const usd = (s: string | number | null | undefined): Dec => Dec.parse(String(s ?? "0"), USD_SCALE, "down");
export const usdStr = (d: Dec): string => Dec.toString(d, { fixed: true });
export const sumUsd = (xs: (string | Dec)[]): Dec => xs.reduce<Dec>((a, x) => Dec.add(a, typeof x === "string" ? usd(x) : x), usd("0"));

// ---------------------------------------------------------------- dates (UTC days)

export function assertDay(day: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error(`not a UTC day: ${day}`);
}
export function addDays(day: string, n: number): string {
  assertDay(day);
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
const dayStart = (day: string) => new Date(`${day}T00:00:00Z`);

// ---------------------------------------------------------------- approvals (venue truth)

export interface HlReader {
  /** Hyperliquid `maxBuilderFee(user, builder)`: tenths of a basis point; 0 = no approval. */
  maxBuilderFee(user: Hex, builder: Hex): Promise<number>;
}

/** Public Hyperliquid info read (no key), with a short backoff on 429. */
export function hlInfoReader(http: typeof fetch = fetch, base = "https://api.hyperliquid.xyz"): HlReader {
  return {
    async maxBuilderFee(user, builder) {
      for (let attempt = 0; ; attempt++) {
        const r = await http(`${base}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "maxBuilderFee", user, builder }) });
        if (r.status === 429 && attempt < 4) {
          await Bun.sleep(500 * 2 ** attempt);
          continue;
        }
        if (!r.ok) throw new Error(`hyperliquid maxBuilderFee: status ${r.status}`);
        const v = (await r.json()) as unknown;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error("hyperliquid maxBuilderFee: not a non-negative integer");
        return v;
      }
    },
  };
}

export interface ApprovalCount {
  hl: number;
  aster: number;
  union: number;
  /** Owners in our database whose approval the venue does not confirm (flagged, not counted). */
  flagged: number;
  asterRead: boolean;
}

const lower = (a: string) => a.toLowerCase();

/**
 * Count unique wallets with an approved Capstan builder fee. `owners` are the candidates (from our delegations);
 * only venue reads decide. A wallet approved on both venues counts once in `union`.
 */
export async function countApprovals(
  owners: Hex[],
  deps: { hl: HlReader; builder: Hex; asterApproved?: () => Promise<Hex[]>; dbAster?: Hex[]; concurrency?: number },
): Promise<ApprovalCount> {
  const uniq = [...new Set(owners.map(lower))] as Hex[];
  const hlSet = new Set<string>();
  const conc = Math.max(1, deps.concurrency ?? 4);
  for (let i = 0; i < uniq.length; i += conc) {
    const batch = uniq.slice(i, i + conc);
    const fees = await Promise.all(batch.map((u) => deps.hl.maxBuilderFee(u, deps.builder)));
    batch.forEach((u, j) => {
      if (fees[j]! > 0) hlSet.add(u);
    });
  }
  let asterSet = new Set<string>();
  let asterRead = false;
  if (deps.asterApproved) {
    asterSet = new Set((await deps.asterApproved()).map(lower));
    asterRead = true;
  }
  const union = new Set([...hlSet, ...asterSet]);
  // flagged: a database delegation the venue does not confirm
  let flagged = uniq.filter((u) => !hlSet.has(u)).length;
  if (asterRead && deps.dbAster) flagged += [...new Set(deps.dbAster.map(lower))].filter((u) => !asterSet.has(u)).length;
  return { hl: hlSet.size, aster: asterSet.size, union: union.size, flagged, asterRead };
}

// ---------------------------------------------------------------- run-rate and thresholds

/** Routed notional run-rate a month: the last 7 full days ending on `endDay` x 30 / 7, per venue and total. */
export function runRate(days: UsageDay[], endDay: string): { perVenue: Record<NotionalVenue, string>; total: string; daysFound: number } {
  const want = new Set(daysBetween(addDays(endDay, -6), endDay));
  const used = days.filter((d) => want.has(d.day));
  const perVenue = {} as Record<NotionalVenue, string>;
  let total = usd("0");
  for (const v of NOTIONAL_VENUES) {
    const s = sumUsd(used.map((d) => d.routedNotionalUsd[v]));
    const monthly = Dec.div(Dec.mul(s, Dec.parse("30", 0), USD_SCALE, "down"), Dec.parse("7", 0), USD_SCALE, "down");
    perVenue[v] = usdStr(monthly);
    total = Dec.add(total, s);
  }
  const totalMonthly = Dec.div(Dec.mul(total, Dec.parse("30", 0), USD_SCALE, "down"), Dec.parse("7", 0), USD_SCALE, "down");
  return { perVenue, total: usdStr(totalMonthly), daysFound: used.length };
}

export const THRESHOLDS = { day14Approvals: 25, day30RunRateUsd: "30000000", day60RunRateUsd: "150000000" } as const;

/** The three pre-set checks. A check whose day has no data yet has pass = null. */
export function killCriteria(days: UsageDay[], launchDay: string): { day14: Verdict; day30: Verdict; day60: Verdict } {
  assertDay(launchDay);
  const byDay = new Map(days.map((d) => [d.day, d]));
  const d14 = addDays(launchDay, 14);
  const at14 = byDay.get(d14);
  const day14: Verdict = at14
    ? { metric: "wallets with an approved builder fee (HL or Aster, venue data)", value: String(at14.approvals.union), threshold: `>= ${THRESHOLDS.day14Approvals}`, pass: at14.approvals.union >= THRESHOLDS.day14Approvals, note: `on ${d14}` }
    : { metric: "wallets with an approved builder fee (HL or Aster, venue data)", value: null, threshold: `>= ${THRESHOLDS.day14Approvals}`, pass: null, note: `no data for ${d14} yet` };
  const rr = (n: number, threshold: string): Verdict => {
    const end = addDays(launchDay, n);
    const metric = "routed notional run-rate a month (last 7 days x 30 / 7)";
    if (!byDay.has(end)) return { metric, value: null, threshold: `>= $${threshold}`, pass: null, note: `no data for ${end} yet` };
    const r = runRate(days, end);
    const pass = Dec.cmp(usd(r.total), usd(threshold)) >= 0;
    return { metric, value: r.total, threshold: `>= $${threshold}`, pass, note: `7 days ending ${end}${r.daysFound < 7 ? `, ${7 - r.daysFound} days missing (counted as 0)` : ""}` };
  };
  return { day14, day30: rr(30, THRESHOLDS.day30RunRateUsd), day60: rr(60, THRESHOLDS.day60RunRateUsd) };
}

// ---------------------------------------------------------------- computing and storing one day

export interface ComputeDeps {
  db: Db;
  hl?: HlReader;
  builder?: Hex; // Capstan's HL builder address (pinned in the SDK); unset = HL approvals not read
  asterApproved?: () => Promise<Hex[]>;
  visitors?: (day: string) => Promise<number | null>;
}

const n = (v: unknown) => Number(v ?? 0);

export async function computeDay(day: string, deps: ComputeDeps): Promise<UsageDay> {
  assertDay(day);
  const db = deps.db;
  const start = dayStart(day);
  const end = dayStart(addDays(day, 1));

  // approvals: candidates from our delegations created before the end of the day
  const dg = schema.delegations;
  const cand = await db.select({ owner: dg.owner, venue: dg.venue }).from(dg).where(and(lt(dg.createdAt, end), inArray(dg.venue, ["hyperliquid", "aster"])));
  const hlOwners = [...new Set(cand.filter((c) => c.venue === "hyperliquid").map((c) => lower(c.owner)))] as Hex[];
  const asterOwners = [...new Set(cand.filter((c) => c.venue === "aster").map((c) => lower(c.owner)))] as Hex[];
  const approvals: ApprovalCount =
    deps.hl && deps.builder
      ? await countApprovals(hlOwners, { hl: deps.hl, builder: deps.builder, asterApproved: deps.asterApproved, dbAster: asterOwners })
      : { hl: 0, aster: 0, union: 0, flagged: 0, asterRead: false };

  // notional and fees: reconciled accruals for HL and Aster, Capstan fills for Lighter
  const acc = schema.builderFeeAccruals;
  const accRows = await db
    .select({ venue: acc.venue, notional: sql<string>`coalesce(sum(${acc.notionalUsd}), 0)`, fee: sql<string>`coalesce(sum(${acc.feeUsd}), 0)` })
    .from(acc)
    .where(eq(acc.day, day))
    .groupBy(acc.venue);
  const f = schema.fills;
  const fillRows = await db
    .select({ venue: f.venue, notional: sql<string>`coalesce(sum(abs(${f.px} * ${f.sz})), 0)` })
    .from(f)
    .where(and(isNotNull(f.orderId), gte(f.ts, start), lt(f.ts, end), inArray(f.venue, ["lighter-mainnet", "lighter-rh"])))
    .groupBy(f.venue);
  const routed: Record<NotionalVenue, Dec> = { hl: usd("0"), aster: usd("0"), lighter304: usd("0"), lighterRh: usd("0") };
  const fees = { hl: usd("0"), aster: usd("0") };
  for (const r of accRows) {
    const k = VENUE_KEY[r.venue];
    if (k !== "hl" && k !== "aster") continue;
    routed[k] = Dec.add(routed[k], usd(r.notional));
    fees[k] = Dec.add(fees[k], usd(r.fee));
  }
  for (const r of fillRows) {
    const k = VENUE_KEY[r.venue];
    if (k) routed[k] = Dec.add(routed[k], usd(r.notional));
  }

  // x402: settled payments of the day, 6-decimal token units
  const xp = schema.x402Payments;
  const pay = await db.select({ chain: xp.chain, asset: xp.asset, amount: xp.amount }).from(xp).where(and(eq(xp.status, "settled"), gte(xp.ts, start), lt(xp.ts, end)));
  const byRailDec = new Map<string, Dec>();
  let x402Usd = usd("0");
  for (const p of pay) {
    const v = Dec.parse(String(p.amount), 0);
    const u = Dec.rescale({ v: v.v, scale: USD_SCALE }, USD_SCALE);
    x402Usd = Dec.add(x402Usd, u);
    const k = `${p.chain}:${p.asset.toLowerCase()}`;
    byRailDec.set(k, Dec.add(byRailDec.get(k) ?? usd("0"), u));
  }

  // mcp calls and unique clients from the request log (hashed client ids)
  const rl = schema.requestLogs;
  const [mcp] = await db
    .select({ calls: sql<string>`count(*)`, clients: sql<string>`count(distinct ${rl.clientHash})` })
    .from(rl)
    .where(and(eq(rl.service, "mcp"), eq(rl.route, "tools/call"), gte(rl.ts, start), lt(rl.ts, end)));
  const [api] = await db
    .select({ calls: sql<string>`count(*)`, clients: sql<string>`count(distinct ${rl.clientHash})` })
    .from(rl)
    .where(and(eq(rl.service, "api"), gte(rl.ts, start), lt(rl.ts, end)));

  // refusals by code
  const ed = schema.eligibilityDecisions;
  const ref = await db
    .select({ code: ed.code, c: sql<string>`count(*)` })
    .from(ed)
    .where(and(eq(ed.allowed, false), gte(ed.ts, start), lt(ed.ts, end)))
    .groupBy(ed.code);

  return {
    day,
    approvals: { hl: approvals.hl, aster: approvals.aster, union: approvals.union },
    approvalsDb: new Set([...hlOwners, ...asterOwners]).size,
    approvalsFlagged: approvals.flagged,
    asterApprovalsRead: approvals.asterRead,
    routedNotionalUsd: { hl: usdStr(routed.hl), aster: usdStr(routed.aster), lighter304: usdStr(routed.lighter304), lighterRh: usdStr(routed.lighterRh) },
    builderFeeUsd: { hl: usdStr(fees.hl), aster: usdStr(fees.aster) },
    x402: { payments: pay.length, usd: usdStr(x402Usd), byRail: Object.fromEntries([...byRailDec].sort().map(([k, v]) => [k, usdStr(v)])) },
    mcp: { calls: n(mcp?.calls), uniqueClients: n(mcp?.clients) },
    api: { requests: n(api?.calls), uniqueClients: n(api?.clients) },
    visitors: deps.visitors ? await deps.visitors(day) : null,
    refusals: Object.fromEntries(ref.map((r) => [r.code ?? "unknown", n(r.c)]).sort()),
  };
}

/** Flatten a day into usage_daily metric rows. */
export function toRows(u: UsageDay): { day: string; metric: string; value: string }[] {
  const r: { day: string; metric: string; value: string }[] = [];
  const add = (metric: string, value: string | number) => r.push({ day: u.day, metric, value: String(value) });
  add("approvals.hl", u.approvals.hl);
  add("approvals.aster", u.approvals.aster);
  add("approvals.union", u.approvals.union);
  if (u.approvalsDb !== undefined) add("approvals.db", u.approvalsDb);
  if (u.approvalsFlagged !== undefined) add("approvals.flagged", u.approvalsFlagged);
  if (u.asterApprovalsRead !== undefined) add("approvals.aster_read", u.asterApprovalsRead ? 1 : 0);
  for (const v of NOTIONAL_VENUES) add(`routed_notional_usd.${v}`, u.routedNotionalUsd[v]);
  add("builder_fee_usd.hl", u.builderFeeUsd.hl);
  add("builder_fee_usd.aster", u.builderFeeUsd.aster);
  add("x402.payments", u.x402.payments);
  add("x402.usd", u.x402.usd);
  for (const [k, v] of Object.entries(u.x402.byRail)) add(`x402.rail.${k}`, v);
  add("mcp.calls", u.mcp.calls);
  add("mcp.unique_clients", u.mcp.uniqueClients);
  add("api.requests", u.api.requests);
  add("api.unique_clients", u.api.uniqueClients);
  if (u.visitors !== null) add("visitors", u.visitors);
  for (const [k, v] of Object.entries(u.refusals)) add(`refusals.${k}`, v);
  return r;
}

export function fromRows(day: string, rows: { metric: string; value: string }[]): UsageDay {
  const m = new Map(rows.map((r) => [r.metric, r.value]));
  const num = (k: string) => Number(m.get(k) ?? 0);
  const str = (k: string) => usdStr(usd(m.get(k) ?? "0"));
  const pick = (prefix: string) => Object.fromEntries([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
  return {
    day,
    approvals: { hl: num("approvals.hl"), aster: num("approvals.aster"), union: num("approvals.union") },
    approvalsDb: m.has("approvals.db") ? num("approvals.db") : undefined,
    approvalsFlagged: m.has("approvals.flagged") ? num("approvals.flagged") : undefined,
    asterApprovalsRead: m.has("approvals.aster_read") ? num("approvals.aster_read") === 1 : undefined,
    routedNotionalUsd: { hl: str("routed_notional_usd.hl"), aster: str("routed_notional_usd.aster"), lighter304: str("routed_notional_usd.lighter304"), lighterRh: str("routed_notional_usd.lighterRh") },
    builderFeeUsd: { hl: str("builder_fee_usd.hl"), aster: str("builder_fee_usd.aster") },
    x402: { payments: num("x402.payments"), usd: str("x402.usd"), byRail: Object.fromEntries(Object.entries(pick("x402.rail.")).map(([k, v]) => [k, usdStr(usd(v))])) },
    mcp: { calls: num("mcp.calls"), uniqueClients: num("mcp.unique_clients") },
    api: { requests: num("api.requests"), uniqueClients: num("api.unique_clients") },
    visitors: m.has("visitors") ? num("visitors") : null,
    refusals: Object.fromEntries(Object.entries(pick("refusals.")).map(([k, v]) => [k, Number(v)])),
  };
}

/** Replace a day's rows (idempotent: re-running a day replaces its rows). */
export async function writeDay(db: Db, u: UsageDay): Promise<number> {
  const rows = toRows(u);
  await db.transaction(async (tx) => {
    await tx.delete(schema.usageDaily).where(eq(schema.usageDaily.day, u.day));
    if (rows.length) await tx.insert(schema.usageDaily).values(rows);
  });
  return rows.length;
}

export async function readDays(db: Db, from: string, to: string): Promise<UsageDay[]> {
  assertDay(from);
  assertDay(to);
  const t = schema.usageDaily;
  const rows = await db.select().from(t).where(and(gte(t.day, from), sql`${t.day} <= ${to}`));
  const by = new Map<string, { metric: string; value: string }[]>();
  for (const r of rows) by.set(r.day, [...(by.get(r.day) ?? []), { metric: r.metric, value: String(r.value) }]);
  return [...by.keys()].sort().map((d) => fromRows(d, by.get(d)!));
}
