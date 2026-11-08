// R1-8-05 (security review round 1): the funding forecaster must not load every raw tick of the last 7 days for every
// market each minute (10,080+ rows per market, grouped in quadratic time on the shared workers event loop). History
// comes from the funding_hourly continuous aggregate plus the last few hours of ticks bucketed by hour in SQL, so the
// points per market stay bounded (7 x 24 hourly points plus a few) whatever the tick density or uptime.
// Needs DATABASE_URL (Postgres with TimescaleDB, as in docker-compose.yml).
import { afterAll, describe, expect, mock, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import type { Market } from "@capstan/schema";

const PG = process.env.DATABASE_URL;
const real = { ...(await import("@capstan/quote")) };
// keep the real function: mock.module updates the live module object in place
const realForecast = real.forecast as (...a: unknown[]) => unknown;
const seen = new Map<string, number>();
// pass-through: record how many history points each market's forecast was given
mock.module("@capstan/quote", () => ({ ...real, forecast: (m: Market, h: unknown[], ...rest: unknown[]) => (seen.set(m.id, h.length), realForecast(m, h, ...rest)) }));

const NOW = new Date("2026-11-08T12:30:20.000Z");
const MAX_POINTS = 7 * 24 + 5;

(PG ? describe : describe.skip)("funding-forecaster history is bounded (R1-8-05)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterAll(async () => cleanup?.(), 60_000);

  test(
    "7 days of minute and 30 s ticks: each forecast gets at most 7 x 24 hourly points plus a few",
    async () => {
      const { createTempDatabase, createDb, closeDb } = await import("@capstan/core");
      const { db: schema } = await import("@capstan/schema");
      const { sql } = await import("drizzle-orm");
      const { runFundingTick } = await import("../src/jobs/funding-forecaster.job");
      const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_ffs" });
      const db = createDb(t.url, { max: 2 });
      cleanup = async () => {
        await closeDb(db);
        await t.drop();
      };
      // the migration's background refresh policy would race the test's own refresh (55P03, "another refresh is
      // running"): drop it in this temp database; the refresh below still retries if a run had already started
      await db.execute(sql`SELECT remove_continuous_aggregate_policy('funding_hourly', if_exists => true)`);
      await db.insert(schema.venues).values({ id: "aster", execution: true, caps: { venue: "aster", canWithdraw: false }, status: "active" });
      const ids = ["aster:-:BTC", "aster:-:ETH", "aster:-:SOL"];
      for (const [i, id] of ids.entries()) {
        const sym = id.split(":")[2]!;
        await db.insert(schema.canonicalAssets).values({ id: `CR:${sym}`, class: "CR", displayName: sym }).onConflictDoNothing();
        await db.insert(schema.markets).values({ id, venue: "aster", dex: null, venueSymbol: `${sym}USDT`, marketType: "perp", canonicalAsset: `CR:${sym}`, collateralAsset: "USDT", tickSize: "0.1", lotSize: "0.001", minNotional: null, maxLeverage: 20, marginModes: ["cross"], fundingIntervalS: 28_800, fundingSettleIntervalS: 28_800, sessionHours: null, oiCapUsd: null, builderFeeUnit: "tenths_bp", status: "active", executable: true, dataFreshness: "live", updatedAt: NOW } as never);
        // one tick a minute for 7 days (the third market one every 30 s, denser like ingest-readonly), a constant rate
        const step = i === 2 ? "30 seconds" : "1 minute";
        await db.execute(sql`INSERT INTO funding_ticks (ts, market_id, rate_per_interval, interval_s, rate_per_hour, predicted_next, source)
          SELECT g, ${id}, 0.00008, 28800, 0.00001, NULL, 'venue'
          FROM generate_series(${new Date(NOW.getTime() - 7 * 86_400_000).toISOString()}::timestamptz, ${new Date(NOW.getTime() - 60_000).toISOString()}::timestamptz, ${step}::interval) g`);
      }
      const kv = new Map<string, string>();
      const run = () => runFundingTick({ db, cache: memoryMarketDataCache(), kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) }, now: () => NOW });

      // before the aggregate is refreshed: only the recent hours, still a forecast for every market
      seen.clear();
      let r = await run();
      expect(r.forecasts).toBe(3);
      for (const id of ids) {
        expect(seen.get(id)).toBeGreaterThan(0);
        expect(seen.get(id)).toBeLessThanOrEqual(MAX_POINTS);
      }

      // after the continuous aggregate policy has run: 7 days of hourly points, never the raw ticks
      for (let attempt = 1; ; attempt++) {
        try {
          await db.execute(sql`CALL refresh_continuous_aggregate('funding_hourly', NULL, NULL)`);
          break;
        } catch (e) {
          const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
          if (code !== "55P03" || attempt >= 20) throw e;
          await new Promise((res) => setTimeout(res, 500));
        }
      }
      seen.clear();
      r = await run();
      expect(r.forecasts).toBe(3);
      for (const id of ids) {
        expect(seen.get(id)).toBeGreaterThanOrEqual(7 * 24 - 2);
        expect(seen.get(id)).toBeLessThanOrEqual(MAX_POINTS);
        const fc = JSON.parse(kv.get(`md:forecast:${id}`)!) as { settlements: { predictedRatePerHour: string; method: string }[] };
        expect(fc.settlements[0]).toMatchObject({ method: "ewma_rate" });
        expect(Number(fc.settlements[0]!.predictedRatePerHour)).toBeCloseTo(0.00001, 12);
      }
    },
    120_000,
  );
});
