// Migration 0006 (policy_alerts) adds NOT NULL nonce and agent_refs to agent_policies. On a table that already has
// rows it must backfill them from the stored policy instead of failing, and keep the per-owner nonce index buildable.
// Needs DATABASE_URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, createDb, createTempDatabase, listMigrations, migrate, MIGRATIONS_DIR, type Db } from "@capstan/core";
import { sql } from "drizzle-orm";
import { HOOK_MS, PG } from "./db";

const TAG = "0006_policy_alerts";

/** A copy of the migrations folder whose journal stops just before `tag`. */
function migrationsBefore(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "capstan-mig-before-"));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const path = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: { idx: number; tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === tag);
  if (at < 0) throw new Error(`no ${tag} in the journal`);
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(path, JSON.stringify(journal));
  return dir;
}

const d = PG ? describe : describe.skip;
d("migration 0006 on a populated agent_policies", () => {
  let t: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  let before: string;
  beforeAll(async () => {
    t = await createTempDatabase(PG!, { prefix: "capstan_pol_mig" });
    before = migrationsBefore(TAG);
    db = createDb(t.url, { max: 2 });
  }, HOOK_MS);
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
    if (before) rmSync(before, { recursive: true, force: true });
  }, HOOK_MS);

  test("backfills-nonce-and-agent-refs", async () => {
    const first = await migrate(t.url, before);
    expect(first.applied).not.toContain(TAG);
    expect(first.applied.length).toBe(listMigrations().findIndex((m) => m.tag === TAG));
    const exp = "2027-01-01T00:00:00Z";
    const rows: [string, string, unknown][] = [
      ["p1", "0xaaa", { nonce: "n1", agents: [{ venue: "hyperliquid", agentRef: "ag2" }, { venue: "aster", agentRef: "ag1" }, { venue: "hyperliquid", agentRef: "ag1" }] }],
      ["p2", "0xaaa", { nonce: "n1", agents: [{ venue: "hyperliquid", agentRef: "ag3" }] }], // the same owner reused n1
      ["p3", "0xbbb", { nonce: "n1", agents: [] }], // another owner may use n1
      ["p4", "0xbbb", { expiresAt: exp }], // no nonce and no agents at all
    ];
    for (const [id, owner, policy] of rows)
      await db.execute(sql`insert into agent_policies (id, owner, policy, owner_sig, expires_at) values (${id}, ${owner}, ${JSON.stringify(policy)}::jsonb, '0x', ${exp})`);

    const second = await migrate(t.url);
    expect(second.applied[0]).toBe(TAG);

    const got = (await db.execute(sql`select id, nonce, agent_refs from agent_policies order by id`)) as unknown as { id: string; nonce: string; agent_refs: string[] }[];
    expect(got.map((r) => [r.id, r.nonce, r.agent_refs])).toEqual([
      ["p1", "n1", ["ag1", "ag2"]],
      ["p2", "legacy:p2", ["ag3"]],
      ["p3", "n1", []],
      ["p4", "legacy:p4", []],
    ]);
    const cols = (await db.execute(sql`select column_name, is_nullable, column_default from information_schema.columns where table_name = 'agent_policies' and column_name in ('nonce', 'agent_refs') order by column_name`)) as unknown as { column_name: string; is_nullable: string; column_default: string | null }[];
    expect(cols).toEqual([
      { column_name: "agent_refs", is_nullable: "NO", column_default: null },
      { column_name: "nonce", is_nullable: "NO", column_default: null },
    ]);
    // the unique per-owner nonce index is live after the backfill
    const reuse = async () => {
      await db.execute(sql`insert into agent_policies (id, owner, policy, owner_sig, expires_at, nonce, agent_refs) values ('p5', '0xaaa', '{}'::jsonb, '0x', ${exp}, 'n1', '{}')`);
    };
    await expect(reuse()).rejects.toThrow();
  });
});
