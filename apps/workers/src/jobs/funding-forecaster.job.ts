// funding-tick, every 60 s (spec 9): for every market with a canonical asset, read the latest funding snapshot from
// the market data cache, write it to funding_ticks at the minute (a re-run in the same minute updates the same row),
// compute the next 8 settlements, cache md:forecast:<marketId> for 120 s and publish PUBSUB.funding(asset) when the
// forecast changed. Funding is observed and changes hourly; a forecast is an estimate.
import { PUBSUB, type Db, type JobDef, type JobDeps, type MarketDataCache } from "@capstan/core";
import { forecast, normalise, type Forecast, type FundingTick } from "@capstan/quote";
import { db as schema, type CanonicalAsset, type FundingSnapshot, type Market } from "@capstan/schema";
import { rowToMarket } from "@capstan/catalog";
import { and, gte, inArray, isNotNull, sql } from "drizzle-orm";

export const FORECAST_TTL_MS = 120_000;
export const HISTORY_WINDOW_MS = 7 * 86_400_000;
export const forecastKey = (marketId: string) => `md:forecast:${marketId}`;

export interface ForecastKv {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, ttlMs: number): Promise<void>;
}

export interface FundingTickDeps {
  db: Db;
  cache: Pick<MarketDataCache, "getFunding">;
  kv: ForecastKv;
  publish?: (channel: string, payload: unknown) => Promise<void>;
  now: () => Date;
}

export interface FundingTickReport {
  markets: number;
  ticksWritten: number;
  forecasts: number;
  published: number;
}

export function minuteFloor(d: Date): Date {
  return new Date(d.getTime() - (d.getTime() % 60_000));
}

/** The venue's prediction as a per-hour rate (predictedNext is per interval, like ratePerInterval). */
export function predictionPerHour(f: FundingSnapshot | null): string | null {
  if (!f?.predictedNext) return null;
  return normalise(f.predictedNext, f.intervalS).ratePerHour;
}

export async function runFundingTick(d: FundingTickDeps): Promise<FundingTickReport> {
  const now = d.now();
  const ts = minuteFloor(now);
  const rows = await d.db.select().from(schema.markets).where(isNotNull(schema.markets.canonicalAsset));
  const markets: Market[] = rows.map(rowToMarket);
  const report: FundingTickReport = { markets: markets.length, ticksWritten: 0, forecasts: 0, published: 0 };
  if (!markets.length) return report;

  const snaps = new Map<string, FundingSnapshot>();
  for (const m of markets) {
    const f = await d.cache.getFunding(m.id);
    if (f) snaps.set(m.id, f);
  }
  const values = [...snaps.values()].map((f) => ({ ts, marketId: f.marketId, ratePerInterval: f.ratePerInterval, intervalS: f.intervalS, ratePerHour: f.ratePerHour, predictedNext: f.predictedNext, source: "venue" }));
  for (let i = 0; i < values.length; i += 500) {
    const chunk = values.slice(i, i + 500);
    await d.db
      .insert(schema.fundingTicks)
      .values(chunk)
      .onConflictDoUpdate({
        target: [schema.fundingTicks.marketId, schema.fundingTicks.ts],
        set: { ratePerInterval: sql`excluded.rate_per_interval`, intervalS: sql`excluded.interval_s`, ratePerHour: sql`excluded.rate_per_hour`, predictedNext: sql`excluded.predicted_next`, source: sql`excluded.source` },
      });
    report.ticksWritten += chunk.length;
  }

  const hist = await d.db
    .select({ ts: schema.fundingTicks.ts, marketId: schema.fundingTicks.marketId, ratePerHour: schema.fundingTicks.ratePerHour })
    .from(schema.fundingTicks)
    .where(and(inArray(schema.fundingTicks.marketId, markets.map((m) => m.id)), gte(schema.fundingTicks.ts, new Date(now.getTime() - HISTORY_WINDOW_MS))));
  const byMarket = new Map<string, FundingTick[]>();
  for (const h of hist) byMarket.set(h.marketId, [...(byMarket.get(h.marketId) ?? []), { ts: h.ts, marketId: h.marketId, ratePerHour: String(h.ratePerHour) }]);

  for (const m of markets) {
    const f = snaps.get(m.id) ?? null;
    const fc: Forecast = forecast(m, byMarket.get(m.id) ?? [], predictionPerHour(f), now, { venueNext: f?.nextSettlementAt ?? null, ...(f ? { capPerHour: f.capPerHour } : {}) });
    if (!fc.settlements.length) continue;
    report.forecasts++;
    const body = JSON.stringify(fc);
    const prev = await d.kv.get(forecastKey(m.id));
    await d.kv.set(forecastKey(m.id), body, FORECAST_TTL_MS);
    if (prev !== body && d.publish && m.canonicalAsset) {
      await d.publish(PUBSUB.funding(m.canonicalAsset as CanonicalAsset), { marketId: m.id, forecast: fc });
      report.published++;
    }
  }
  return report;
}

export function redisKv(redis: { get(k: string): Promise<string | null>; set(k: string, v: string, px: "PX", ms: number): Promise<unknown> }): ForecastKv {
  return {
    get: (k) => redis.get(k),
    async set(k, v, ms) {
      await redis.set(k, v, "PX", ms);
    },
  };
}

export const job: JobDef = {
  name: "funding-forecaster",
  queue: "fundingTick",
  schedule: { every: 60_000 },
  concurrency: 1,
  async handler(_job, deps: JobDeps) {
    if (!deps.db || !deps.cache || !deps.redis) throw new Error("funding-forecaster needs the database, the cache and Redis");
    const redis = deps.redis;
    return runFundingTick({
      db: deps.db,
      cache: deps.cache,
      kv: redisKv(redis),
      publish: deps.publish ?? (async (ch, p) => void (await redis.publish(ch, JSON.stringify(p)))),
      now: deps.now,
    });
  },
};
