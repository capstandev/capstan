// The catalog source and the ingest job definition (drop-in files under apps/workers/src/jobs).
import { afterAll, describe, expect, test } from "bun:test";
import { syncMarkets } from "@capstan/catalog";
import { closeDb, createDb, createTempDatabase, memoryMarketDataCache, TEST_DATABASE_URL } from "@capstan/core";
import { db as tables } from "@capstan/schema";
import { createMemoryGovernor } from "@capstan/venue-client";
import { hyperliquidSource } from "../../../../apps/workers/src/jobs/catalog-sources/hyperliquid.source";
import { job } from "../../../../apps/workers/src/jobs/ingest-hl.job";
import { createHlReader, type HlRuntime } from "../src";
import { CFG, fixtureHttp } from "./helpers";


function fixtureRuntime(): HlRuntime {
  const http = fixtureHttp();
  return { cfg: CFG, governor: createMemoryGovernor("t"), http, reader: createHlReader(CFG, http, memoryMarketDataCache()) };
}

describe("source", () => {
  test("lists-markets-and-dexes", async () => {
    const src = hyperliquidSource(fixtureRuntime());
    expect(src.venue).toBe("hyperliquid");
    const ms = await src.listMarkets();
    expect(ms.length).toBe(235 + 143 + 16 + 15 + 25 + 23 + 1 + 17 + 40 + 24 + 19);
    expect(ms.every((m) => m.executable === false)).toBe(true);
    const dexes = await src.listDexes!();
    expect(dexes.map((d) => [d.dex, d.index])).toEqual([["xyz", 1], ["flx", 2], ["vntl", 3], ["hyna", 4], ["km", 5], ["abcd", 6], ["cash", 7], ["para", 8], ["mkts", 9], ["io", 10]]);
    expect(dexes.find((d) => d.dex === "xyz")!.liveMarkets).toBe(120);
    expect(dexes.find((d) => d.dex === "flx")!.liveMarkets).toBe(0);
  });

  test("ingest-job-definition", () => {
    expect(job).toMatchObject({ name: "ingest-hl", queue: "fundingTick", schedule: { every: 60_000 }, concurrency: 1 });
    expect(typeof job.handler).toBe("function");
  });

  const dbTest = TEST_DATABASE_URL ? test : test.skip;
  let drop: (() => Promise<void>) | null = null;
  afterAll(async () => {
    await drop?.();
  });
  dbTest("catalog-sync-with-source", async () => {
    const tmp = await createTempDatabase(TEST_DATABASE_URL!, { migrated: true, prefix: "capstan_hlsrc" });
    drop = tmp.drop;
    const db = createDb(tmp.url, { max: 2 });
    try {
      const report = await syncMarkets(db, [hyperliquidSource(fixtureRuntime())], new Date("2026-11-06T00:15:00Z"));
      expect(report.errors).toEqual([]);
      expect(report.newDexes.length).toBe(10);
      const rows = await db.select().from(tables.markets);
      expect(rows.length).toBe(558);
      expect(rows.every((r) => r.executable === false)).toBe(true);
      const tsla = rows.find((r) => r.id === "hyperliquid:xyz:TSLA")!;
      expect(tsla.venueIndex).toBe(1);
    } finally {
      await closeDb(db);
    }
  }, 60_000);
});
