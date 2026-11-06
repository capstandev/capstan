// lock-snapshot and staker-credits job definitions; lock-snapshot writes one row per locked owner per UTC day
// (idempotent) and does nothing before CPSTLock is deployed; the governance export writes owner,amount CSV.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, logger, schema, type Db, type JobDeps } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPoll, parseArgs } from "../../../ops/governance/export-poll";
import { dayStartUtc, job as snapJob, runLockSnapshot, sourceFromEnv } from "../src/jobs/lock-snapshot.job";
import { job as stakerJob } from "../src/jobs/staker-credits.job";

const PG = process.env.DATABASE_URL;
const quiet = logger("t", { sink: () => {} });

describe("plans jobs", () => {
  test("definitions", () => {
    expect(snapJob).toMatchObject({ name: "lock-snapshot", queue: "reconcileDaily", schedule: { pattern: "30 0 * * *" }, concurrency: 1 });
    expect(stakerJob).toMatchObject({ name: "staker-credits", queue: "reconcileDaily", schedule: { pattern: "0 1 1 * *" }, concurrency: 1 });
    expect(dayStartUtc(new Date("2026-11-06T23:59:59Z")).toISOString()).toBe("2026-11-06T00:00:00.000Z");
    // no CPSTLock deployment on the network: no source
    expect(sourceFromEnv({ CAPSTAN_NETWORK: "testnet", RHC_TESTNET_RPC_URL: "http://127.0.0.1:1" })).toBeNull();
    expect(parseArgs(["--ts", "2026-12-01T00:00:00Z", "--out", "x.csv"]).ts.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(() => parseArgs(["--ts", "nope", "--out", "x"])).toThrow();
  });
});

(PG ? describe : describe.skip)("plans jobs with a database", () => {
  let db: Db;
  let url: string;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_pj" });
    url = t.url;
    db = createDb(t.url, { max: 2 });
    drop = async () => {
      await closeDb(db);
      await t.drop();
    };
  }, 30_000);
  afterAll(async () => {
    await drop?.();
  }, 30_000);

  test("snapshot and export", async () => {
    const deps: JobDeps = { db, redis: null, cache: null, log: quiet, now: () => new Date("2026-12-01T00:30:00Z") };
    expect(await runLockSnapshot(deps, null)).toBe(0);
    const amounts: Record<string, bigint> = { "0x00000000000000000000000000000000000000a1": 5n * 10n ** 23n, "0x00000000000000000000000000000000000000a2": 0n };
    let fail = false;
    const source = {
      lock: { lockedOf: async (o: Hex) => {
        if (fail) throw new Error("rpc down");
        return { amount: amounts[o.toLowerCase()] ?? 0n, unlockAt: 0n };
      } },
      lockOwners: async () => Object.keys(amounts) as Hex[],
    };
    expect(await runLockSnapshot(deps, source)).toBe(1); // a2 has nothing locked
    expect(await runLockSnapshot(deps, source)).toBe(1); // same day again: no duplicate rows
    expect((await db.select().from(schema.lockSnapshots)).length).toBe(1);
    fail = true;
    await expect(runLockSnapshot({ ...deps, now: () => new Date("2026-12-02T00:30:00Z") }, source)).rejects.toThrow("rpc down"); // no partial snapshot
    expect((await db.select().from(schema.lockSnapshots)).length).toBe(1);

    const dir = mkdtempSync(join(tmpdir(), "capstan-poll-"));
    try {
      const out = join(dir, "nested", "poll.csv");
      expect(await exportPoll(url, new Date("2026-12-01T00:00:00Z"), out)).toBe(1);
      expect(readFileSync(out, "utf8")).toBe("owner,amount\n0x00000000000000000000000000000000000000a1,500000000000000000000000\n");
      expect(await exportPoll(url, new Date("2026-12-09T00:00:00Z"), join(dir, "empty.csv"))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
