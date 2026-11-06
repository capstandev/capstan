// R9 (todo 18): funding-tick is idempotent per minute (primary key (market_id, ts); a re-run in the same minute
// updates the same row) and caches and publishes forecasts.
import { afterAll, describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import type { Forecast } from "@capstan/quote";
import { forecastKey, job, minuteFloor, predictionPerHour, runFundingTick, type ForecastKv } from "../src/jobs/funding-forecaster.job";

const PG = process.env.DATABASE_URL;

describe("funding-forecaster", () => {
  test("definition", () => {
    expect(job).toMatchObject({ name: "funding-forecaster", queue: "fundingTick", schedule: { every: 60_000 }, concurrency: 1 });
    expect(minuteFloor(new Date("2026-11-06T10:20:59.999Z")).toISOString()).toBe("2026-11-06T10:20:00.000Z");
    // a per-interval prediction (Variational 4 h) becomes per hour
    expect(predictionPerHour({ marketId: "v", ratePerInterval: "0.00005", intervalS: 14_400, ratePerHour: "0.0000125", rateAnnualised: "0.1095", predictedNext: "0.00005", nextSettlementAt: "", capPerHour: null, source: "venue", asOf: "" })).toBe("0.0000125");
  });
});

(PG ? describe : describe.skip)("funding-forecaster with a database", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterAll(async () => {
    await cleanup?.();
  }, 30_000);
  test(
    "idempotent",
    async () => {
      const { createTempDatabase, createDb, closeDb } = await import("@capstan/core");
      const { db: schema } = await import("@capstan/schema");
      const { eq } = await import("drizzle-orm");
      const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_ff" });
      const db = createDb(t.url, { max: 2 });
      cleanup = async () => {
        await closeDb(db);
        await t.drop();
      };
      await db.insert(schema.venues).values({ id: "hyperliquid", execution: true, caps: { venue: "hyperliquid", canWithdraw: false }, status: "active" });
      await db.insert(schema.canonicalAssets).values({ id: "CR:BTC", class: "CR", displayName: "BTC" }).onConflictDoNothing();
      await db.insert(schema.markets).values({ id: "hyperliquid:-:BTC", venue: "hyperliquid", dex: null, venueSymbol: "BTC", marketType: "perp", canonicalAsset: "CR:BTC", collateralAsset: "USDC", tickSize: "0.1", lotSize: "0.00001", minNotional: null, maxLeverage: 40, marginModes: ["cross"], fundingIntervalS: 28_800, fundingSettleIntervalS: 3600, sessionHours: null, oiCapUsd: null, builderFeeUnit: "tenths_bp", status: "active", executable: true, dataFreshness: "live", updatedAt: new Date("2026-11-06T00:00:00Z") } as never);
      const cache = memoryMarketDataCache();
      const kv = new Map<string, string>();
      const store: ForecastKv = { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v) };
      const published: [string, unknown][] = [];
      const snap = (rate: string) => ({ marketId: "hyperliquid:-:BTC", ratePerInterval: rate, intervalS: 3600, ratePerHour: rate, rateAnnualised: "0", predictedNext: rate, nextSettlementAt: "2026-11-06T11:00:00.000Z", capPerHour: "0.04", source: "venue" as const, asOf: "2026-11-06T10:20:00.000Z" });
      const run = (at: string) => runFundingTick({ db, cache, kv: store, publish: async (c, p) => void published.push([c, p]), now: () => new Date(at) });

      await cache.putFunding(snap("0.0000125"));
      const a = await run("2026-11-06T10:20:05Z");
      expect(a).toMatchObject({ markets: 1, ticksWritten: 1, forecasts: 1, published: 1 });
      // same minute, new value: the same row is updated, never duplicated
      await cache.putFunding(snap("0.00002"));
      await run("2026-11-06T10:20:40Z");
      let rows = await db.select().from(schema.fundingTicks).where(eq(schema.fundingTicks.marketId, "hyperliquid:-:BTC"));
      expect(rows.length).toBe(1);
      expect(rows[0]!.ts.toISOString()).toBe("2026-11-06T10:20:00.000Z");
      expect(Number(rows[0]!.ratePerHour)).toBe(0.00002);
      // the next minute is a new row
      await run("2026-11-06T10:21:01Z");
      rows = await db.select().from(schema.fundingTicks).where(eq(schema.fundingTicks.marketId, "hyperliquid:-:BTC"));
      expect(rows.length).toBe(2);
      // the forecast is cached and published on change only (the third run changed nothing)
      const fc = JSON.parse(kv.get(forecastKey("hyperliquid:-:BTC"))!) as Forecast;
      expect(fc.settlements.length).toBe(8);
      expect(fc.settlements[0]).toMatchObject({ method: "venue", predictedRatePerHour: "0.00002", at: "2026-11-06T11:00:00.000Z" });
      expect(published.map((p) => p[0])).toEqual(["ps:funding:CR:BTC", "ps:funding:CR:BTC"]);
    },
    30_000,
  );
});
