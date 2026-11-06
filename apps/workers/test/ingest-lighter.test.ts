// ingest-lighter job: definition, first tick opens one stream per config with the live perps only, a tick with the
// same markets does not resubscribe, events reach the cache, and Timescale gets at most one row per market and kind
// per minute (with Postgres; that part skips without DATABASE_URL).
import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, logger, memoryMarketDataCache, type JobDeps } from "@capstan/core";
import { LIGHTER_CONFIGS, lighterReaderFor, type LighterIngest } from "@capstan/adapter-lighter";
import { db as schema, type MarketEvent } from "@capstan/schema";
import { createMemoryGovernor, fakeVenueServer, loadFixtureRecord } from "@capstan/venue-client";
import { join } from "node:path";
import { job, persistEvent, runIngestTick, stopIngest } from "../src/jobs/ingest-lighter.job";
import { source as mainSource } from "../src/jobs/catalog-sources/lighter.source";
import { source as rhSource } from "../src/jobs/catalog-sources/lighter-rh.source";

const FX = join(import.meta.dir, "../../../packages/adapters/lighter/test/fixtures");
const quiet = logger("test", { sink: () => {} });
const serve = (v: string, n: string) => {
  const r = loadFixtureRecord<unknown>(v, n, FX);
  return new Response(JSON.stringify(r.response), { status: r.status, headers: { "content-type": "application/json" } });
};
const fake = (v: string) =>
  fakeVenueServer({
    "GET /api/v1/orderBooks": () => serve(v, "orderBooks"),
    "GET /api/v1/orderBookDetails": () => serve(v, "orderBookDetails"),
  });
const main = fake("lighter-304");
const rh = fake("lighter-466324");
afterAll(() => {
  main.stop();
  rh.stop();
});

function fakeIngest() {
  const starts: { ids: string[]; emit: (e: MarketEvent) => void }[] = [];
  const ing: LighterIngest = {
    start(markets, onEvent) {
      starts.push({ ids: markets.map((m) => m.id), emit: onEvent });
      return () => undefined;
    },
    stats: () => ({ connections: 1, subscriptions: starts.at(-1)?.ids.length ?? 0, books: starts.at(-1)?.ids.length ?? 0, gaps: 0, maxSubsPerConn: 500 }),
    close: () => undefined,
  };
  return { ing, starts };
}

describe("ingest-lighter job", () => {
  test("definition and sources", () => {
    expect(job).toMatchObject({ name: "ingest-lighter", queue: "fundingTick", schedule: { every: 300_000 }, concurrency: 1 });
    expect(mainSource.venue).toBe("lighter-mainnet");
    expect(rhSource.venue).toBe("lighter-rh");
  });

  test("tick opens streams once for live perps and feeds the cache", async () => {
    const cache = memoryMarketDataCache();
    const deps: JobDeps = { db: null, redis: null, cache, log: quiet, now: () => new Date() };
    const ingests = { mainnet: fakeIngest(), rh: fakeIngest() };
    const urls: Record<string, string> = { "lighter-mainnet": main.url, "lighter-rh": rh.url };
    const f = {
      reader: (cfg: (typeof LIGHTER_CONFIGS)["mainnet"]) => lighterReaderFor(cfg, createMemoryGovernor("t"), cache, { rest: urls[cfg.venue]! }),
      ingest: (cfg: (typeof LIGHTER_CONFIGS)["mainnet"]) => (cfg.venue === "lighter-rh" ? ingests.rh.ing : ingests.mainnet.ing),
    };
    const r1 = await runIngestTick(deps, f, null);
    expect(r1.configs.map((c) => [c.venue, c.markets])).toEqual([
      ["lighter-mainnet", 214],
      ["lighter-rh", 67],
    ]);
    expect(ingests.mainnet.starts.length).toBe(1);
    expect(ingests.mainnet.starts[0]!.ids.every((id) => id.startsWith("lighter-mainnet:"))).toBe(true);
    const r2 = await runIngestTick(deps, f, r1.state);
    expect(r2.configs[0]!.markets).toBe(214);
    expect(ingests.mainnet.starts.length).toBe(1); // same set: no resubscribe
    ingests.mainnet.starts[0]!.emit({ kind: "mark", marketId: "lighter-mainnet:-:ETH", mark: "2243.03", asOf: new Date().toISOString() });
    await Bun.sleep(5);
    expect(await cache.getMark("lighter-mainnet:-:ETH")).toMatchObject({ mark: "2243.03" });
    stopIngest(r2.state);
  });

  (process.env.DATABASE_URL ? test : test.skip)(
    "persist at most once per market and kind per minute",
    async () => {
      const t = await createTempDatabase(process.env.DATABASE_URL!, { migrated: true, prefix: "capstan_lig" });
      const db = createDb(t.url, { max: 2 });
      try {
        const run = { lastPersist: new Map<string, number>() };
        const at = Date.UTC(2026, 10, 6, 3, 0, 0);
        const mark: MarketEvent = { kind: "mark", marketId: "lighter-rh:-:AMZN", mark: "250.10", index: "250.00", asOf: new Date(at).toISOString() };
        const book: MarketEvent = { kind: "book", book: { marketId: "lighter-rh:-:AMZN", bids: [["250.0", "1"]], asks: [["250.2", "2"]], asOf: new Date(at).toISOString() } };
        const fund: MarketEvent = {
          kind: "funding",
          funding: { marketId: "lighter-rh:-:AMZN", ratePerInterval: "0.0004", intervalS: 3600, ratePerHour: "0.000004", rateAnnualised: "0.03504", predictedNext: null, nextSettlementAt: new Date(at + 3_600_000).toISOString(), capPerHour: "0.005", source: "venue", asOf: new Date(at).toISOString() },
        };
        expect(await persistEvent(db, run, mark, at)).toBe(true);
        expect(await persistEvent(db, run, mark, at + 30_000)).toBe(false);
        expect(await persistEvent(db, run, mark, at + 61_000)).toBe(true);
        expect(await persistEvent(db, run, book, at)).toBe(true);
        expect(await persistEvent(db, run, fund, at)).toBe(true);
        expect((await db.select().from(schema.markTicks)).length).toBe(2);
        expect((await db.select().from(schema.bookSnapshots)).length).toBe(1);
        const f = await db.select().from(schema.fundingTicks);
        expect(f.length).toBe(1);
        expect(f[0]).toMatchObject({ marketId: "lighter-rh:-:AMZN", intervalS: 3600, source: "venue" });
      } finally {
        await closeDb(db);
        await t.drop();
      }
    },
    60_000,
  );
});
