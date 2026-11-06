// R14: the catalog-sync Job Scheduler is upserted once (id catalog-sync, tz UTC); the job reports and raises alerts.
import { afterAll, describe, expect, test } from "bun:test";
import { createQueue, createRedis, logger, type JobDeps } from "@capstan/core";
import { join } from "node:path";
import { startJobs } from "../src/runner";
import { job, loadSources, OPS_ALERT_CHANNEL, runCatalogSync, SOURCES_DIR } from "../src/jobs/catalog-sync.job";
import { runCli } from "../src/cli/catalog-review";

const REDIS = process.env.REDIS_URL;
const PG = process.env.DATABASE_URL;
const quiet = logger("test", { sink: () => {} });
// Creating and migrating a throwaway database can exceed Bun's 5 s default on a loaded runner.
const DB_TEST_TIMEOUT_MS = 30_000;

describe("catalog-sync job", () => {
  test("definition", async () => {
    expect(job).toMatchObject({ name: "catalog-sync", queue: "catalogSync", schedule: { pattern: "15 0 * * *" }, concurrency: 1 });
    expect(SOURCES_DIR.endsWith(join("jobs", "catalog-sources"))).toBe(true);
    expect(await loadSources()).toEqual([]); // adapters add their sources; none yet in this lane
  });

  (REDIS ? test : test.skip)("schedule", async () => {
    const redis = createRedis(REDIS!, { forBullmq: true });
    const prefix = `capstan-test-cs-${process.pid}`;
    const deps: JobDeps = { db: null, redis, cache: null, log: quiet, now: () => new Date() };
    try {
      const a = await startJobs([job], deps, redis, prefix);
      await a.stop();
      const b = await startJobs([job], deps, redis, prefix); // a restart upserts the same scheduler
      await b.stop();
      const q = createQueue("catalogSync", redis, prefix);
      const s = await q.getJobSchedulers();
      expect(s.length).toBe(1);
      expect(s[0]).toMatchObject({ key: "catalog-sync", pattern: "15 0 * * *", tz: "UTC" });
      await q.obliterate({ force: true });
      await q.close();
    } finally {
      await redis.quit();
    }
  });
});

(PG ? describe : describe.skip)("catalog-sync with a database", () => {
  let drop: (() => Promise<void>) | null = null;
  afterAll(async () => {
    await drop?.();
  }, DB_TEST_TIMEOUT_MS);

  test("report, alerts and the review CLI", async () => {
    const { createTempDatabase, createDb, closeDb } = await import("@capstan/core");
    const { hyperliquidSource, asterSource } = await import("../../../packages/catalog/test/fixture-sources");
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_wk" });
    const db = createDb(t.url, { max: 2 });
    drop = async () => {
      await closeDb(db);
      await t.drop();
    };
    const published: [string, unknown][] = [];
    const deps: JobDeps = { db, redis: null, cache: null, log: quiet, now: () => new Date("2026-11-06T00:15:00Z"), publish: async (c, p) => void published.push([c, p]) };
    const broken = { venue: "arcus" as const, listMarkets: async () => Promise.reject(new Error("down")) };
    const r = await runCatalogSync(deps, [hyperliquidSource(), asterSource(), broken]);
    expect(r.newDexes.length).toBeGreaterThan(5);
    expect(published.map((p) => p[0])).toEqual([OPS_ALERT_CHANNEL, OPS_ALERT_CHANNEL]);
    expect(published.map((p) => (p[1] as { kind: string }).kind)).toEqual(["catalog.new_dexes", "catalog.source_errors"]);

    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) };
    expect(await runCli(["list"], db, io)).toBe(0);
    expect(out.join("\n")).toContain("dexes not reviewed:");
    out.length = 0;
    expect(await runCli(["propose", "EQ:TSLA", "hyperliquid:xyz:TSLA", "aster:-:TSLAUSDT", "--notes", "same TSLA?"], db, io)).toBe(0);
    const id = out[0]!.replace("proposed ", "");
    out.length = 0;
    // approve prints the diff and refuses the blocking collateral difference without an override reason
    expect(await runCli(["approve", id, "--reviewer", "rev", "--notes", "n"], db, io)).toBe(1);
    expect(out.some((l) => l.includes("collateralAsset") && l.includes("BLOCKING"))).toBe(true);
    expect(out.at(-1)).toContain("needs --override-reason");
    out.length = 0;
    expect(await runCli(["approve", id, "--reviewer", "rev", "--notes", "n", "--override-reason", "legs keep their own collateral"], db, io)).toBe(0);
    expect(out.join("\n")).toContain(`approved ${id}`);
    expect(await runCli(["dex", "hyperliquid", "flx", "--reviewer", "rev", "--notes", "n"], db, io)).toBe(1);
    expect(await runCli(["nope"], db, io)).toBe(2);
  }, DB_TEST_TIMEOUT_MS);
});
