// Release gate 2026-11-08 G-3: the pending-order sweep read one page of the 200 oldest unsettled rows. Unknown rows it
// cannot look up (Aster) stay unsettled, so with 200 of them in the 24 h window every newer pending row was never
// swept and its receipt waited up to 24 h. The sweep now pages through the window by (submittedAt, id). The pg case
// needs DATABASE_URL.
import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, type Db } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { memoryRelayStore, pgRelayStore } from "../src/stores";
import { SWEEP_MIN_AGE_MS, SWEEP_UNKNOWN_AFTER_MS, sweepPendingOrders } from "../src/sweep";
import type { NewOrderRow, RelayStore } from "../src/types";

const NOW = 1_800_000_000_000;
const OWNER = "0x00000000000000000000000000000000000b0b03" as Hex;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const row = (i: number, status: string, venue: "aster" | "hyperliquid", at: number): NewOrderRow => ({ id: `ord-g3-${String(i).padStart(4, "0")}`, buildId: `bld-g3-${i}`, venue, marketId: `${venue}:-:BTC`, owner: OWNER, signedPayloadHash: hash(i + 1), mode: "relay", status, builderFeeBps: 0, submittedAt: new Date(at) });

/** 250 unknown Aster rows (all at one instant, so the id breaks the tie), then one newer pending Hyperliquid row. */
const ROWS = [...Array.from({ length: 250 }, (_, i) => row(i, "unknown", "aster", NOW - 6 * 3_600_000)), row(999, "pending", "hyperliquid", NOW - Math.max(SWEEP_MIN_AGE_MS, SWEEP_UNKNOWN_AFTER_MS) - 60_000)];

async function sweepVisits(store: RelayStore): Promise<{ visited: string[]; checked: number }> {
  const visited: string[] = [];
  const spy: RelayStore = { ...store, getBuild: async (id) => (visited.push(id), null) };
  const out = await sweepPendingOrders({ store: spy, venues: new Map(), receipts: { issue: async () => Promise.reject(new Error("no receipt here")) }, now: () => NOW } as never);
  return { visited, checked: out.checked };
}

describe("gate G-3: the sweep reads past a page of unknown rows", () => {
  test("memory store", async () => {
    const s = memoryRelayStore();
    for (const r of ROWS) await s.insertOrder(r);
    const { visited, checked } = await sweepVisits(s);
    expect(checked).toBe(ROWS.length);
    expect(visited).toContain("bld-g3-999");
    expect(new Set(visited).size).toBe(ROWS.length); // no row read twice across pages
  });

  const PG = process.env.DATABASE_URL;
  let tmp: Awaited<ReturnType<typeof createTempDatabase>> | undefined;
  let db: Db | undefined;
  afterAll(async () => {
    if (db) await closeDb(db);
    await tmp?.drop();
  }, 60_000);
  test.skipIf(!PG)("postgres store", async () => {
    tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_gate_g3" });
    db = createDb(tmp.url, { max: 4 });
    const { sql } = await import("drizzle-orm");
    for (const r of ROWS) await db.execute(sql`insert into order_builds (id, owner, venue, market_id, intent, payload, preview, eligibility_decision_id, expires_at) values (${r.buildId}, ${OWNER}, ${r.venue}, ${r.marketId}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'elig-g3', now())`);
    const s = pgRelayStore(db);
    for (const r of ROWS) expect(await s.insertOrder(r)).toBe(true);
    const { visited, checked } = await sweepVisits(s);
    expect(checked).toBe(ROWS.length);
    expect(visited).toContain("bld-g3-999");
    expect(new Set(visited).size).toBe(ROWS.length);
  }, 60_000);
});
