// R1-8-04 (security review round 1): the spread event log is bounded. A plan takes at most two leg_b_sent and two
// leg_b_filled events (the executor's retry_then_flatten), leg B never reports more than leg A filled, event data is
// allow-listed per kind and capped at 4 KB, and two concurrent posts of the same step store one event and one receipt.
// Runs on the Postgres store when DATABASE_URL is set, and always on the memory store.
import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, type Db } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { dbPlanStore, memoryPlanStore, plan, recordEvent, type EventDeps, type EventLog, type PlanStore } from "../../src";
import { setup } from "../scan/helpers";

const PG = process.env.DATABASE_URL;
const OWNER = "0x00000000000000000000000000000000000000c4" as Hex;
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
}, 60_000);

async function pgStore(): Promise<PlanStore & EventLog> {
  const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_spbd" });
  const db: Db = createDb(t.url, { max: 4 });
  cleanups.push(async () => {
    await closeDb(db);
    await t.drop();
  });
  return dbPlanStore(db);
}

const stores: [string, () => Promise<PlanStore & EventLog>][] = [["memory", async () => memoryPlanStore()], ...(PG ? ([["postgres", pgStore]] as [string, () => Promise<PlanStore & EventLog>][]) : [])];

for (const [name, make] of stores) {
  describe(`spread event bounds (${name} store)`, () => {
    let n = 0;
    async function fixture(o: { venueDelayMs?: number } = {}) {
      const store = await make();
      const s = setup();
      const id = `01JPLANBOUNDS${name === "memory" ? "M" : "P"}${String(++n).padStart(12, "0")}`;
      const p = await plan({ owner: OWNER, equivalenceId: "eq-eth", sizeBase: "1", leverage: 3, hedgeFailurePolicy: "retry_then_flatten" }, { ...s.deps, store, id: () => id });
      await store.setStatus(p.planId, "acked", "0xsig");
      const receipts: string[] = [];
      const deps: EventDeps = {
        store,
        events: store,
        receipts: { issue: async (action) => (receipts.push(action), { receiptId: `r${receipts.length}` }) },
        venueFill: async () => (o.venueDelayMs ? await new Promise((r) => setTimeout(r, o.venueDelayMs)) : undefined, null),
        now: () => new Date("2026-11-01T12:01:00.000Z"),
      };
      const post = (kind: string, data: unknown) => recordEvent(p.planId, { kind: kind as never, data }, deps);
      return { store, p, deps, receipts, post };
    }

    test("leg B events are capped: a third leg_b_sent and a third leg_b_filled are refused", async () => {
      const f = await fixture();
      await f.post("leg_a_sent", { buildId: "bA", venueOrderId: "vA", size: "1" });
      await f.post("leg_a_filled", { buildId: "bA", venueOrderId: "vA", filled: "1", avgPx: "2000" });
      await f.post("leg_b_sent", { buildId: "bB", venueOrderId: "vB1", size: "1" });
      await f.post("leg_b_filled", { buildId: "bB", venueOrderId: "vB1", filled: "0.1" });
      await f.post("leg_b_sent", { buildId: "bB2", venueOrderId: "vB2", size: "0.9", retry: true });
      await f.post("leg_b_filled", { buildId: "bB2", venueOrderId: "vB2", filled: "0.1" });
      await expect(f.post("leg_b_filled", { buildId: "bB2", venueOrderId: "vB3", filled: "0.1" })).rejects.toMatchObject({ code: "BAD_STATE" });
      await expect(f.post("leg_b_sent", { buildId: "bB3", venueOrderId: "vB3", size: "0.8" })).rejects.toMatchObject({ code: "BAD_STATE" });
      expect((await f.store.list(f.p.planId)).length).toBe(6);
      expect(f.receipts.filter((r) => r === "spread.leg").length).toBe(3);
    });

    test("leg B can never report more than leg A filled", async () => {
      const f = await fixture();
      await f.post("leg_a_sent", { buildId: "bA", venueOrderId: "vA" });
      await f.post("leg_a_filled", { buildId: "bA", venueOrderId: "vA", filled: "0.5" });
      await f.post("leg_b_sent", { buildId: "bB", venueOrderId: "vB" });
      await expect(f.post("leg_b_filled", { buildId: "bB", venueOrderId: "vB", filled: "0.6" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await f.post("leg_b_filled", { buildId: "bB", venueOrderId: "vB", filled: "0.3" });
      await f.post("leg_b_sent", { buildId: "bB2", venueOrderId: "vB2", retry: true });
      await expect(f.post("leg_b_filled", { buildId: "bB2", venueOrderId: "vB2", filled: "0.3" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    test("event data is allow-listed per kind and capped at 4 KB", async () => {
      const f = await fixture();
      await expect(f.post("leg_a_sent", { buildId: "bA", venueOrderId: "vA", junk: "x".repeat(1_000_000) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(f.post("leg_a_sent", { buildId: "bA", venueOrderId: "vA", extra: "1" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(f.post("failed", { reason: "x".repeat(5000) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(f.post("failed", { reason: { nested: { deep: ["x".repeat(3000), "y".repeat(3000)] } } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await f.store.list(f.p.planId)).toEqual([]);
      // the executor's own events pass unchanged
      await f.post("leg_a_sent", { buildId: "bA", venueOrderId: "vA", size: "1" });
      await f.post("leg_a_filled", { buildId: "bA", venueOrderId: "vA", filled: "1", avgPx: null, final: false });
      await f.post("leg_b_sent", { buildId: "bB", venueOrderId: null, size: "1" });
      await f.post("unhedged", { residualDeltaBase: "1", reason: "leg B filled only partly", legAFilled: "1", legBFilled: "0", stateUnknown: ["leg B not confirmed finished: a later fill would reduce the residual"] });
      expect((await f.store.get(f.p.planId))!.plan.status).toBe("unhedged");
    });

    test("two concurrent posts of the same step: one event, one receipt", async () => {
      const f = await fixture({ venueDelayMs: 20 });
      await f.post("leg_a_sent", { buildId: "bA", venueOrderId: "vA" });
      const r = await Promise.allSettled([1, 2, 3].map(() => f.post("leg_a_filled", { buildId: "bA", venueOrderId: "vA", filled: "1" })));
      expect(r.filter((x) => x.status === "fulfilled").length).toBe(1);
      expect(f.receipts.filter((x) => x === "spread.leg").length).toBe(1);
      expect((await f.store.list(f.p.planId)).filter((e) => e.kind === "leg_a_filled").length).toBe(1);
      // two concurrent plan ends: one terminal event, one spread.plan receipt
      await f.post("leg_b_sent", { buildId: "bB", venueOrderId: "vB" });
      const ends = await Promise.allSettled([f.post("unhedged", { residualDeltaBase: "1" }), f.post("complete", { residualDeltaBase: "0" })]);
      expect(ends.filter((x) => x.status === "fulfilled").length).toBe(1);
      expect(f.receipts.filter((x) => x === "spread.plan").length).toBe(1);
    });
  });
}
