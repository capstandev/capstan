// R9: a leg_a_filled event whose fill disagrees with the venue read by more than one lot is stored with mismatch true
// and an ops alert; receipts are issued per leg and per plan. Runs on the Postgres store when DATABASE_URL is set,
// else on the memory store.
import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, PUBSUB, type Db } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { dbPlanStore, memoryPlanStore, plan, recordEvent, type EventDeps, type EventLog, type PlanStore } from "../../src";
import { setup } from "../scan/helpers";

const PG = process.env.DATABASE_URL;
const OWNER = "0x00000000000000000000000000000000000000c3" as Hex;
let cleanup: (() => Promise<void>) | null = null;
afterAll(async () => cleanup?.(), 60_000);

async function storeFor(): Promise<PlanStore & EventLog> {
  if (!PG) return memoryPlanStore();
  const t = await createTempDatabase(PG, { migrated: true, prefix: "capstan_spev" });
  const db: Db = createDb(t.url, { max: 2 });
  cleanup = async () => {
    await closeDb(db);
    await t.drop();
  };
  return dbPlanStore(db);
}

describe("plan events", () => {
  test("cross-check-and-receipts", async () => {
    const store = await storeFor();
    const s = setup();
    const p = await plan({ owner: OWNER, equivalenceId: "eq-eth", sizeBase: "1", leverage: 3, hedgeFailurePolicy: "leave_open" }, { ...s.deps, store, id: () => "01JPLANEVENTS000000000000A" });
    const receipts: { action: string; input: Record<string, unknown> }[] = [];
    const alerts: unknown[] = [];
    const published: string[] = [];
    const venueFills = new Map<string, string>([["vA", "0.98"], ["vB", "0.5"]]);
    const deps: EventDeps = {
      store,
      events: store,
      receipts: { issue: async (action, input) => (receipts.push({ action, input }), { receiptId: `r${receipts.length}` }) },
      venueFill: async (_v, id) => (venueFills.has(id) ? { filled: venueFills.get(id)! } : null),
      alert: (x) => void alerts.push(x),
      publish: async (c) => void published.push(c),
      policyIdFor: async () => "POLICY1",
      now: () => new Date("2026-11-01T12:01:00.000Z"),
    };
    // events need an acked plan
    await expect(recordEvent(p.planId, { kind: "leg_a_sent", data: {} }, deps)).rejects.toMatchObject({ code: "BAD_STATE" });
    await store.setStatus(p.planId, "acked", "0xsig");
    expect((await recordEvent(p.planId, { kind: "leg_a_sent", data: { buildId: "bA", venueOrderId: "vA" } }, deps)).status).toBe("leg_a_sent");
    // reported 0.98 vs venue 0.98: within one lot, no mismatch; spread.leg receipt with the policy id
    const lot = (p.legA.payloadTemplate.payload as { lotSize: string }).lotSize;
    const okFill = await recordEvent(p.planId, { kind: "leg_a_filled", data: { buildId: "bA", venueOrderId: "vA", filled: "0.98", avgPx: "2000" }, signedPayloadHash: `0x${"ab".repeat(32)}` }, deps);
    expect(okFill).toMatchObject({ status: "leg_a_filled", mismatch: false, receiptIds: ["r1"] });
    expect(receipts[0]).toMatchObject({ action: "spread.leg", input: { owner: OWNER, venue: p.legA.venue, marketId: p.legA.marketId, buildId: "bA", policyId: "POLICY1", venueOrderId: "vA" } });
    expect(lot).toBe("0.0001");
    // leg B reported 0.9 but the venue read says 0.5: more than one lot apart -> mismatch stored, ops alert
    await recordEvent(p.planId, { kind: "leg_b_sent", data: { buildId: "bB", venueOrderId: "vB" } }, deps);
    const bad = await recordEvent(p.planId, { kind: "leg_b_filled", data: { buildId: "bB", venueOrderId: "vB", filled: "0.9", avgPx: "2001" } }, deps);
    expect(bad.mismatch).toBe(true);
    expect(alerts).toEqual([{ kind: "spreads.event_mismatch", detail: { planId: p.planId, eventKind: "leg_b_filled", reported: "0.9", venueRead: "0.5", venue: p.legB.venue } }]);
    const evs = await store.list(p.planId);
    expect(evs.find((e) => e.kind === "leg_b_filled")!.data).toMatchObject({ mismatch: true, venueFilled: "0.5" });
    expect(evs.find((e) => e.kind === "leg_a_filled")!.data).toMatchObject({ mismatch: false, signedPayloadHash: `0x${"ab".repeat(32)}` });
    // the plan ends: one spread.plan receipt with the quote snapshot hash
    const end = await recordEvent(p.planId, { kind: "unhedged", data: { residualDeltaBase: "0.08" } }, deps);
    expect(end.status).toBe("unhedged");
    expect(receipts.map((r) => r.action)).toEqual(["spread.leg", "spread.leg", "spread.plan"]);
    expect(receipts[2]!.input.quoteSnapshotHash).toBe((await store.get(p.planId))!.quoteSnapshotHash);
    expect((await store.get(p.planId))!.plan.status).toBe("unhedged");
    expect(new Set(published)).toEqual(new Set([PUBSUB.plan(p.planId)]));
    // the plan is over: nothing but a later flatten is accepted; a terminal residual is required
    await expect(recordEvent(p.planId, { kind: "complete", data: { residualDeltaBase: "0" } }, deps)).rejects.toMatchObject({ code: "BAD_STATE" });
    await expect(recordEvent(p.planId, { kind: "flattened", data: {} }, deps)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // a fill with no venue read is stored as unverified (mismatch null), never as matching
    const p2 = await plan({ owner: OWNER, equivalenceId: "eq-eth", sizeBase: "1", leverage: 3, hedgeFailurePolicy: "leave_open" }, { ...s.deps, store, id: () => "01JPLANEVENTS000000000000B" });
    await store.setStatus(p2.planId, "acked", "0xsig2");
    await recordEvent(p2.planId, { kind: "leg_a_sent", data: { buildId: "b2", venueOrderId: "unknown-id" } }, deps);
    expect((await recordEvent(p2.planId, { kind: "leg_a_filled", data: { buildId: "b2", venueOrderId: "unknown-id", filled: "1" } }, deps)).mismatch).toBeNull();
    await expect(recordEvent(p2.planId, { kind: "leg_b_sent" as never, data: {} }, { ...deps })).resolves.toBeDefined();
    await expect(recordEvent(p2.planId, { kind: "bogus" as never, data: {} }, deps)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
