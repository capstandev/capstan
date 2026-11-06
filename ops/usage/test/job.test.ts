import type { Db, JobDeps } from "@capstan/core";
import { logger } from "@capstan/core";
import { db as schema } from "@capstan/schema";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { job, runUsageDaily } from "@capstan/workers/src/jobs/usage-daily.job";
import { readDays } from "../usage";
import { addr, dbDescribe, freshDb, HOOK_TIMEOUT_MS } from "./helpers";

dbDescribe("usage-daily job", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await freshDb()), HOOK_TIMEOUT_MS);
  afterAll(async () => await drop());

  test("idempotent: re-running a day replaces its rows", async () => {
    expect(job).toMatchObject({ name: "usage-daily", queue: "reconcileDaily", schedule: { pattern: "0 3 * * *" }, concurrency: 1 });
    const deps: JobDeps = { db, redis: null, cache: null, log: logger("t", { sink: () => {} }), now: () => new Date(Date.UTC(2026, 10, 6, 3, 0, 0)) };
    await db.insert(schema.delegations).values([
      { id: "d1", venue: "hyperliquid", owner: addr(1), agentAddress: addr(0x11), state: "active", createdAt: new Date(Date.UTC(2026, 10, 1)) },
      { id: "d2", venue: "hyperliquid", owner: addr(2), agentAddress: addr(0x12), state: "active", createdAt: new Date(Date.UTC(2026, 10, 1)) },
    ]);
    let approved = new Set([addr(1)]);
    const hl = { maxBuilderFee: async (u: string) => (approved.has(u as `0x${string}`) ? 20 : 0) };
    await db.insert(schema.builderFeeAccruals).values({ day: "2026-11-05", venue: "hyperliquid", builder: addr(0xb0), fills: 1, notionalUsd: "100", feeUsd: "0.02", unmatchedFills: 0, source: "hl_user_fills" });
    const u1 = await runUsageDaily(deps, { hl, builder: addr(0xb0) }); // yesterday = 2026-11-05
    expect(u1.day).toBe("2026-11-05");
    const rows1 = await db.select().from(schema.usageDaily).where(eq(schema.usageDaily.day, "2026-11-05"));
    // the venue confirms addr(2) later and an accrual is corrected: re-running the day replaces, never adds
    approved = new Set([addr(1), addr(2)]);
    await db.update(schema.builderFeeAccruals).set({ notionalUsd: "250" }).where(eq(schema.builderFeeAccruals.day, "2026-11-05"));
    await runUsageDaily(deps, { hl, builder: addr(0xb0) });
    await runUsageDaily(deps, { hl, builder: addr(0xb0) });
    const rows2 = await db.select().from(schema.usageDaily).where(eq(schema.usageDaily.day, "2026-11-05"));
    expect(rows2.length).toBe(rows1.length);
    const [d] = await readDays(db, "2026-11-05", "2026-11-05");
    expect(d!.approvals).toEqual({ hl: 2, aster: 0, union: 2 });
    expect(d!.approvalsFlagged).toBe(0);
    expect(d!.routedNotionalUsd.hl).toBe("250.000000");
    expect(d!.asterApprovalsRead).toBe(false);
    // another day is untouched
    await runUsageDaily(deps, { hl, builder: addr(0xb0), day: "2026-11-04" });
    expect((await readDays(db, "2026-11-04", "2026-11-05")).map((x) => x.day)).toEqual(["2026-11-04", "2026-11-05"]);
  });
});
