// Migration runner over drizzle-kit's SQL files (packages/core/migrations), with down files and a single-migrator
// advisory lock. Each migration runs in one transaction unless its first line is `-- capstan:no-transaction`
// (Timescale DDL), in which case each statement runs on its own.
//   bun packages/core/src/migrate.ts          apply every pending migration (DATABASE_URL)
//   bun packages/core/src/migrate.ts down     revert every applied migration, newest first
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

export const MIGRATION_LOCK_ID = 7419;
export const MIGRATIONS_DIR = join(import.meta.dir, "../migrations");
const TABLE = "capstan_migrations";
const NO_TX = /^--\s*capstan:no-transaction\b/;

export interface MigrationFile {
  tag: string;
  up: string;
  down: string | null;
}

export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const journal = JSON.parse(readFileSync(join(dir, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map(({ tag }) => {
      const downPath = join(dir, "down", `${tag}.sql`);
      return { tag, up: readFileSync(join(dir, `${tag}.sql`), "utf8"), down: existsSync(downPath) ? readFileSync(downPath, "utf8") : null };
    });
}

export function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !/^\s*--/.test(l))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

type Conn = postgres.ReservedSql;

async function runFile(conn: Conn, sql: string): Promise<void> {
  const stmts = splitStatements(sql);
  if (NO_TX.test(sql.trimStart())) {
    for (const s of stmts) await conn.unsafe(s);
    return;
  }
  await conn.unsafe("BEGIN");
  try {
    for (const s of stmts) await conn.unsafe(s);
    await conn.unsafe("COMMIT");
  } catch (e) {
    await conn.unsafe("ROLLBACK");
    throw e;
  }
}

export interface MigrateResult {
  applied: string[];
  waited: boolean;
}

async function withLock<T>(url: string, fn: (conn: Conn) => Promise<T>): Promise<{ result: T; waited: boolean }> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const conn = await sql.reserve();
  let waited = false;
  try {
    const [row] = await conn`select pg_try_advisory_lock(${MIGRATION_LOCK_ID}) as ok`;
    if (!row?.ok) {
      waited = true;
      await conn`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
    }
    try {
      await conn.unsafe(`CREATE TABLE IF NOT EXISTS ${TABLE} (tag text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const result = await fn(conn);
      return { result, waited };
    } finally {
      await conn`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
    }
  } finally {
    conn.release();
    await sql.end({ timeout: 5 });
  }
}

/** Apply every pending migration. Safe to run from several processes at once: one waits for the other. */
export async function migrate(url: string, dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  const files = listMigrations(dir);
  const { result, waited } = await withLock(url, async (conn) => {
    const done = new Set((await conn.unsafe(`SELECT tag FROM ${TABLE}`)).map((r) => r.tag as string));
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f.tag)) continue;
      await runFile(conn, f.up);
      await conn.unsafe(`INSERT INTO ${TABLE} (tag) VALUES ($1)`, [f.tag]);
      applied.push(f.tag);
    }
    return applied;
  });
  return { applied: result, waited };
}

/** Revert applied migrations newest first (all of them, or down to `toCount` remaining). */
export async function migrateDown(url: string, opts?: { toCount?: number; dir?: string }): Promise<MigrateResult> {
  const files = listMigrations(opts?.dir);
  const { result, waited } = await withLock(url, async (conn) => {
    const done = new Set((await conn.unsafe(`SELECT tag FROM ${TABLE}`)).map((r) => r.tag as string));
    const reverted: string[] = [];
    const applied = files.filter((f) => done.has(f.tag));
    const keep = opts?.toCount ?? 0;
    for (const f of applied.reverse()) {
      if (applied.length - reverted.length <= keep) break;
      if (!f.down) throw new Error(`migrate: ${f.tag} has no down file (migrations/down/${f.tag}.sql)`);
      await runFile(conn, f.down);
      await conn.unsafe(`DELETE FROM ${TABLE} WHERE tag = $1`, [f.tag]);
      reverted.push(f.tag);
    }
    if (reverted.length === applied.length) await conn.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    return reverted;
  });
  return { applied: result, waited };
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("migrate: DATABASE_URL is not set");
    process.exit(2);
  }
  const down = process.argv[2] === "down";
  try {
    const r = down ? await migrateDown(url) : await migrate(url);
    console.log(`migrate: ${down ? "reverted" : "applied"} ${r.applied.length} (${r.applied.join(", ") || "none pending"})${r.waited ? ", waited for another migrator" : ""}`);
  } catch (e) {
    console.error(`migrate: failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
