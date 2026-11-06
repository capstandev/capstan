// Back-test of the EWMA forecast against naive carry (the last rate held), on settled funding history.
// For each settlement after a warm-up, both predict the next per-hour rate from the rows before it; the error is the
// absolute difference in bps per hour. The report states both MAEs; it does not claim the forecast wins.
import type { Db } from "@capstan/core";
import { db as schema } from "@capstan/schema";
import { and, asc, gte, inArray, lte } from "drizzle-orm";
import { DEFAULT_HALF_LIFE_H, ewmaRate } from "./forecast";

export const WARMUP = 24;
export const LOOKBACK = 168; // rows (7 days at hourly cadence)

export interface BacktestRow {
  marketId: string;
  maeForecast: number;
  maeNaiveCarry: number;
  n: number;
}

const bps = (x: string) => Number(x) * 10_000;

/** Pure core: rows already sorted by time per market. */
export function backtestSeries(marketId: string, rows: { ts: number; ratePerHour: string }[], halfLifeH = DEFAULT_HALF_LIFE_H): BacktestRow {
  let ef = 0;
  let en = 0;
  let n = 0;
  for (let i = WARMUP; i < rows.length; i++) {
    const past = rows.slice(Math.max(0, i - LOOKBACK), i);
    const actual = bps(rows[i]!.ratePerHour);
    const f = bps(ewmaRate(past.map((r) => ({ ts: r.ts, rate: r.ratePerHour })), halfLifeH));
    const naive = bps(past[past.length - 1]!.ratePerHour);
    ef += Math.abs(f - actual);
    en += Math.abs(naive - actual);
    n++;
  }
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return { marketId, maeForecast: n ? r6(ef / n) : Number.NaN, maeNaiveCarry: n ? r6(en / n) : Number.NaN, n };
}

export async function backtest(db: Db, marketIds: string[], from: Date, to: Date): Promise<BacktestRow[]> {
  if (!marketIds.length) return [];
  const rows = await db
    .select({ ts: schema.fundingTicks.ts, marketId: schema.fundingTicks.marketId, ratePerHour: schema.fundingTicks.ratePerHour })
    .from(schema.fundingTicks)
    .where(and(inArray(schema.fundingTicks.marketId, marketIds), gte(schema.fundingTicks.ts, from), lte(schema.fundingTicks.ts, to)))
    .orderBy(asc(schema.fundingTicks.marketId), asc(schema.fundingTicks.ts));
  return marketIds.map((id) =>
    backtestSeries(
      id,
      rows.filter((r) => r.marketId === id).map((r) => ({ ts: r.ts.getTime(), ratePerHour: String(r.ratePerHour) })),
    ),
  );
}
