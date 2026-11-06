// R10 (todo 16): ingest-readonly writes marks to mark_ticks and funding to funding_ticks with source 'venue', and keeps
// Variational's real asOf (the quote's updated_at), never the fetch time.
import { afterAll, describe, expect, test } from "bun:test";
import { createArcusAdapter, ARCUS_MAINNET } from "@capstan/adapter-arcus";
import { createVariationalAdapter, isoMs, variationalMarketId, type VariationalStats } from "@capstan/adapter-variational";
import { memoryMarketDataCache } from "@capstan/core";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { job, minuteOf, readonlySources, runReadonlyIngest } from "../src/jobs/ingest-readonly.job";

const PG = process.env.DATABASE_URL;
const ROOT = join(import.meta.dir, "../../../packages/adapters");
const fx = <T>(p: string): T => (JSON.parse(readFileSync(join(ROOT, p), "utf8")) as { response: T }).response;
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const DB_TEST_TIMEOUT_MS = 30_000;

function adapters(nowMs: number) {
  const vf = (async () => json(fx("variational/test/fixtures/stats.json"))) as unknown as typeof fetch;
  const af = (async () => json(fx("arcus/test/fixtures/markets.json"))) as unknown as typeof fetch;
  const v = createVariationalAdapter(venueHttp("variational", "http://variational.invalid", createMemoryGovernor("iv"), { fetchImpl: vf }), null, { now: () => nowMs });
  const a = createArcusAdapter(ARCUS_MAINNET, venueHttp("arcus", ARCUS_MAINNET.rest, createMemoryGovernor("ia"), { fetchImpl: af }), null, { now: () => nowMs });
  return { v, a };
}

describe("ingest-readonly", () => {
  test("definition", () => {
    expect(job).toMatchObject({ name: "ingest-readonly", queue: "fundingTick", schedule: { every: 10_000 }, concurrency: 1 });
  });

  test("cache keeps the venue asOf; one venue failing never stops the other", async () => {
    const nowMs = Date.parse("2026-11-06T01:53:40Z");
    const { v } = adapters(nowMs);
    const cache = memoryMarketDataCache();
    const broken = { venue: "arcus" as const, snapshot: async () => Promise.reject(new Error("down")) };
    const r = await runReadonlyIngest([readonlySources(v, v as never)[0]!, broken], cache, null);
    expect(r.venues.map((x) => [x.venue, Boolean(x.error)])).toEqual([["variational", false], ["arcus", true]]);
    const btc = fx<VariationalStats>("variational/test/fixtures/stats.json").listings.find((l) => l.ticker === "BTC-PERP")!;
    expect(await cache.getMark(variationalMarketId("BTC-PERP"))).toEqual({ mark: btc.mark_price, asOf: isoMs(btc.quotes!.updated_at) });
  });
});

(PG ? describe : describe.skip)("ingest-readonly with a database", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterAll(async () => {
    await cleanup?.();
  }, DB_TEST_TIMEOUT_MS);

  test(
    "writes-with-asof",
    async () => {
      const { createTempDatabase, createDb, closeDb } = await import("@capstan/core");
      const { db: schema } = await import("@capstan/schema");
      const { eq } = await import("drizzle-orm");
      const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_ro" });
      const db = createDb(t.url, { max: 2 });
      cleanup = async () => {
        await closeDb(db);
        await t.drop();
      };
      const nowMs = Date.parse("2026-11-06T01:53:40.250Z");
      const { v, a } = adapters(nowMs);
      const r = await runReadonlyIngest(readonlySources(v, a), memoryMarketDataCache(), db);
      expect(r.venues.every((x) => !x.error)).toBe(true);
      expect(r.markRows).toBeGreaterThan(50);
      expect(r.fundingRows).toBeGreaterThan(50);

      // Variational: ts is the quote updated_at, never the fetch time
      const stats = fx<VariationalStats>("variational/test/fixtures/stats.json");
      const btc = stats.listings.find((l) => l.ticker === "BTC-PERP")!;
      const [mrow] = await db.select().from(schema.markTicks).where(eq(schema.markTicks.marketId, variationalMarketId("BTC-PERP")));
      expect(mrow!.ts.toISOString()).toBe(isoMs(btc.quotes!.updated_at));
      expect(mrow!.ts.getTime()).not.toBe(nowMs);
      expect(Number(mrow!.mark)).toBe(Number(btc.mark_price));
      const [frow] = await db.select().from(schema.fundingTicks).where(eq(schema.fundingTicks.marketId, variationalMarketId("BTC-PERP")));
      expect(frow!.ts.toISOString()).toBe(isoMs(btc.quotes!.updated_at));
      expect(frow!.source).toBe("venue");
      expect(frow!.intervalS).toBe(btc.funding.interval_seconds);

      // Arcus: index (oracle) and OI kept, rows bucketed to the fetch minute, source 'venue'
      const [arow] = await db.select().from(schema.markTicks).where(eq(schema.markTicks.marketId, "arcus:-:BTC-USD"));
      expect(arow!.ts.toISOString()).toBe(minuteOf(new Date(nowMs).toISOString()).toISOString());
      expect(arow!.index).not.toBeNull();
      expect(arow!.oiUsd).not.toBeNull();
      const [af] = await db.select().from(schema.fundingTicks).where(eq(schema.fundingTicks.marketId, "arcus:-:BTC-USD"));
      expect(af).toMatchObject({ source: "venue", intervalS: 3600 });
      expect(Number(af!.ratePerHour)).toBe(0.0000125);
      const allSources = await db.selectDistinct({ s: schema.fundingTicks.source }).from(schema.fundingTicks);
      expect(allSources).toEqual([{ s: "venue" }]);

      // a second tick on the same venue data adds nothing (unique market_id, ts)
      const { v: v2, a: a2 } = adapters(nowMs + 5_000);
      const r2 = await runReadonlyIngest(readonlySources(v2, a2), null, db);
      expect(r2.markRows).toBe(0);
      expect(r2.fundingRows).toBe(0);
    },
    DB_TEST_TIMEOUT_MS,
  );
});
