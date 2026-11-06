// R1-R3: migrations up/down/up, Timescale objects, one migrator at a time. Needs DATABASE_URL (skips without it).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { listMigrations, migrate, migrateDown, MIGRATION_LOCK_ID } from "../src/migrate";
import { createTempDatabase } from "../src/testing";

// Creating a throwaway database can take longer than Bun's 5 s hook default on a loaded runner.
const HOOK_TIMEOUT_MS = 30_000;

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;

async function userTables(url: string): Promise<string[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`;
    return rows.map((r) => r.table_name as string);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

d("migrations", () => {
  let db: Awaited<ReturnType<typeof createTempDatabase>>;
  beforeAll(async () => {
    db = await createTempDatabase(BASE!, { prefix: "capstan_mig" });
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await db?.drop();
  }, HOOK_TIMEOUT_MS);

  test("every migration has a down file", () => {
    for (const m of listMigrations()) expect(m.down, m.tag).not.toBeNull();
  });

  test("up-down-up", async () => {
    const up1 = await migrate(db.url);
    expect(up1.applied).toEqual(listMigrations().map((m) => m.tag));
    const tables = await userTables(db.url);
    expect(tables).toContain("markets");
    expect(tables).toContain("receipts");
    expect(tables).toContain("governance_polls");
    expect((await migrate(db.url)).applied).toEqual([]); // idempotent
    const down = await migrateDown(db.url);
    expect(down.applied).toEqual(listMigrations().map((m) => m.tag).reverse());
    expect(await userTables(db.url)).toEqual([]);
    const up2 = await migrate(db.url);
    expect(up2.applied.length).toBe(listMigrations().length);
    expect(await userTables(db.url)).toEqual(tables);
  });

  test("timescale-objects", async () => {
    const sql = postgres(db.url, { max: 1, onnotice: () => {} });
    try {
      const dims = await sql`select hypertable_name, time_interval from timescaledb_information.dimensions where hypertable_schema = 'public' order by 1`;
      const byName = Object.fromEntries(dims.map((r) => [r.hypertable_name, String(r.time_interval)]));
      expect(byName).toEqual({ book_snapshots: "01:00:00", funding_ticks: "1 day", mark_ticks: "06:00:00", risk_snapshots: "1 day" });
      const ret = await sql`select hypertable_name, config->>'drop_after' as drop_after from timescaledb_information.jobs where proc_name = 'policy_retention' order by 1`;
      expect(ret.map((r) => [r.hypertable_name, r.drop_after])).toEqual([
        ["book_snapshots", "14 days"],
        ["mark_ticks", "180 days"],
      ]);
      const caggs = await sql`select view_name, hypertable_name from timescaledb_information.continuous_aggregates`;
      expect(caggs.map((r) => r.view_name)).toEqual(["funding_hourly"]);
      // the aggregate really aggregates
      await sql`insert into funding_ticks (ts, market_id, rate_per_interval, interval_s, rate_per_hour, source) values
        ('2026-01-01T00:10:00Z', 'm1', '0.0008', 28800, '0.0001', 'venue'), ('2026-01-01T00:40:00Z', 'm1', '0.0024', 28800, '0.0003', 'venue')`;
      await sql`call refresh_continuous_aggregate('funding_hourly', '2025-12-31', '2026-01-02')`;
      const [row] = await sql`select rate_per_hour from funding_hourly where market_id = 'm1'`;
      expect(Number(row!.rate_per_hour)).toBeCloseTo(0.0002, 10);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test("single-migrator", async () => {
    const fresh = await createTempDatabase(BASE!, { prefix: "capstan_mig2" });
    // a third session holds the migration lock, so both migrators must wait on it (deterministic under load)
    const holder = postgres(fresh.url, { max: 1, onnotice: () => {} });
    try {
      await holder`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
      const both = Promise.all([migrate(fresh.url), migrate(fresh.url)]);
      await Bun.sleep(300);
      expect(await userTables(fresh.url)).toEqual([]); // nothing ran while the lock was held
      await holder`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
      const [a, b] = await both;
      const all = listMigrations().map((m) => m.tag);
      // both waited; exactly one applied everything, the other found nothing to do; no deadlock
      expect(a.waited && b.waited).toBe(true);
      expect([a.applied, b.applied].sort((x, y) => y.length - x.length)).toEqual([all, []]);
      expect((await userTables(fresh.url)).length).toBeGreaterThan(30);
    } finally {
      await holder.end({ timeout: 5 });
      await fresh.drop();
    }
  });
});
