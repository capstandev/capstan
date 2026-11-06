// Monthly fee split (Overview 80/10/5/5): totals the month's fee inflows and prints four buckets, amounts only.
//   bun ops/usage/fee-split.ts <YYYY-MM>
// Inflows: Hyperliquid and Aster builder fees (builder_fee_accruals) plus settled x402 payments (which include the
// Pro credit top-ups, shown as their own line and not added twice). Buckets: worker 80%, treasury 10%, stakers 5%,
// burn 5%. While STAKER_BUCKET_ENABLED is off the stakers' 5% is held, not credited. The buckets always sum to the
// inflow exactly (6-decimal integer arithmetic; rounding leftovers go to the treasury line). The burn figure is the
// AMOUNT_USDG input of the burn plan (ops/deploy/burn-plan.sh); the stakers figure is the plans package bucketUsd.
import { closeDb, createDb, type Db } from "@capstan/core";
import { Dec, db as schema } from "@capstan/schema";
import { and, eq, gte, like, lt, sql } from "drizzle-orm";
import { sumUsd, usd, usdStr, USD_SCALE } from "./usage";

export interface FeeSplit {
  month: string;
  inflow: { hlBuilderUsd: string; asterBuilderUsd: string; x402Usd: string; creditTopupsUsd: string; totalUsd: string };
  buckets: { workerUsd: string; treasuryUsd: string; stakersUsd: string; burnUsd: string };
  stakersCredited: boolean;
}

export const SPLIT = { worker: 80n, treasury: 10n, stakers: 5n, burn: 5n } as const;

/** Split a total (decimal USD string) into the four buckets; the leftover from rounding down goes to the treasury. */
export function splitBuckets(totalUsd: string): FeeSplit["buckets"] {
  const t = usd(totalUsd).v;
  if (t < 0n) throw new Error("fee split: negative inflow");
  const part = (pct: bigint) => (t * pct) / 100n;
  const worker = part(SPLIT.worker);
  const stakers = part(SPLIT.stakers);
  const burn = part(SPLIT.burn);
  const treasury = t - worker - stakers - burn;
  const s = (v: bigint) => usdStr({ v, scale: USD_SCALE } as Dec);
  return { workerUsd: s(worker), treasuryUsd: s(treasury), stakersUsd: s(stakers), burnUsd: s(burn) };
}

export function assertMonth(month: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`not a month (YYYY-MM): ${month}`);
}

export async function feeSplit(db: Db, month: string, o: { stakerFlag: boolean }): Promise<FeeSplit> {
  assertMonth(month);
  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const acc = schema.builderFeeAccruals;
  const rows = await db
    .select({ venue: acc.venue, fee: sql<string>`coalesce(sum(${acc.feeUsd}), 0)` })
    .from(acc)
    .where(like(acc.day, `${month}-%`))
    .groupBy(acc.venue);
  const fee = (v: string) => usd(rows.find((r) => r.venue === v)?.fee ?? "0");
  const xp = schema.x402Payments;
  const pays = await db.select({ amount: xp.amount, endpoint: xp.endpoint }).from(xp).where(and(eq(xp.status, "settled"), gte(xp.ts, start), lt(xp.ts, end)));
  const toUsd = (atomic: string) => ({ v: Dec.parse(String(atomic), 0).v, scale: USD_SCALE }) as Dec;
  const x402 = sumUsd(pays.map((p) => toUsd(p.amount)));
  const topups = sumUsd(pays.filter((p) => /\/credits\/topup(\/|$|\?)/.test(p.endpoint)).map((p) => toUsd(p.amount)));
  const total = Dec.add(Dec.add(fee("hyperliquid"), fee("aster")), x402);
  const buckets = splitBuckets(usdStr(total));
  return {
    month,
    inflow: { hlBuilderUsd: usdStr(fee("hyperliquid")), asterBuilderUsd: usdStr(fee("aster")), x402Usd: usdStr(x402), creditTopupsUsd: usdStr(topups), totalUsd: usdStr(total) },
    buckets,
    stakersCredited: o.stakerFlag,
  };
}

export function formatFeeSplit(f: FeeSplit): string {
  const line = (label: string, v: string) => `${label.padEnd(48)} ${v.padStart(18)}`;
  return [
    `Fee split for ${f.month} (USD)`,
    line("Hyperliquid builder fees", f.inflow.hlBuilderUsd),
    line("Aster builder fees", f.inflow.asterBuilderUsd),
    line("x402 settled payments", f.inflow.x402Usd),
    line("  of which Pro credit top-ups (not added again)", f.inflow.creditTopupsUsd),
    line("Total inflow", f.inflow.totalUsd),
    "",
    line("Worker 80%", f.buckets.workerUsd),
    line("Treasury 10% (with rounding leftovers)", f.buckets.treasuryUsd),
    line(f.stakersCredited ? "Stakers 5%: credited" : "Stakers 5%: held (flag off)", f.buckets.stakersUsd),
    line("Burn 5% (AMOUNT_USDG for the burn plan)", f.buckets.burnUsd),
  ].join("\n");
}

if (import.meta.main) {
  const month = process.argv[2] ?? "";
  try {
    assertMonth(month);
  } catch (e) {
    console.error(`usage: bun ops/usage/fee-split.ts <YYYY-MM> (${(e as Error).message})`);
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("fee-split: DATABASE_URL is not set");
    process.exit(1);
  }
  const db = createDb(url, { max: 2 });
  try {
    const flag = process.env.STAKER_BUCKET_ENABLED === "1" || process.env.STAKER_BUCKET_ENABLED === "true";
    console.log(formatFeeSplit(await feeSplit(db, month, { stakerFlag: flag })));
  } finally {
    await closeDb(db);
  }
}
