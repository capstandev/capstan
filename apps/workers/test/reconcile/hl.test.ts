// R1, R2, R3, R10, R11: Hyperliquid reconciliation from recorded userFillsByTime data (one public address, 2026-11-02).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@capstan/core";
import { createHlReader, HL_MAINNET, type HlFill } from "@capstan/adapter-hyperliquid";
import { memoryMarketDataCache } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { createMemoryGovernor, venueHttp, type Governor, type Priority } from "@capstan/venue-client";
import { eq } from "drizzle-orm";
import { reconcileHl } from "../../src/reconcile";
import { BUILDER, collector, fakeCsv, fakeHl, FILLS, FILLS_DAY, FILLS_USER, marketOf, PG, plant, type Planted } from "./helpers";

const U = FILLS_USER as Hex;
const byFee = [...FILLS].filter((f) => Number(f.builderFee ?? 0) > 0);
const single = (() => {
  const n = new Map<string, number>();
  for (const f of FILLS) n.set(String(f.oid), (n.get(String(f.oid)) ?? 0) + 1);
  return { one: FILLS.filter((f) => n.get(String(f.oid)) === 1), multi: [...n.entries()].filter(([, c]) => c > 1).map(([o]) => o) };
})();

describe.skipIf(!PG)("hyperliquid reconciliation", () => {
  let p: Planted;
  beforeAll(async () => {
    p = await plant("hl");
  });
  afterAll(() => p?.drop());

  test("fill-without-receipt", async () => {
    const [a, b, c] = single.one as [HlFill, HlFill, HlFill];
    await p.order({ owner: U, oid: String(a.oid), marketId: marketOf(a.coin) });
    await p.order({ owner: U, oid: String(b.oid), marketId: marketOf(b.coin) });
    await p.order({ owner: U, oid: String(c.oid), marketId: marketOf(c.coin), receipt: false }); // the planted gap
    const al = collector();
    const r = await reconcileHl(FILLS_DAY, { db: p.db, hl: fakeHl({ [U]: FILLS }).hl, builder: BUILDER, csv: fakeCsv({}).csv, publish: al.publish });
    expect(r.fills).toBe(3);
    expect(r.unmatchedFills).toEqual([`hl:${c.hash!.toLowerCase()}:${c.tid}`]);
    expect(r.foreignFills).toBe(byFee.length - 3); // the user's other fills (other builders) are counted, never alerted
    const ev = al.events.filter((e) => e.detail.reason === "fill_without_receipt");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "reconciler.mismatch", detail: { day: FILLS_DAY, venue: "hyperliquid", unmatchedFills: 1 } });
    expect(al.events.every((e) => e.kind === "reconciler.mismatch")).toBe(true);
    // the venue fee is fee - builderFee, subtracted once
    const [row] = await p.db.select().from(schema.fills).where(eq(schema.fills.venueOrderId, String(a.oid)));
    expect(Number(row!.feeUsd) + Number(row!.builderFeeUsd)).toBeCloseTo(Number(a.fee), 9);
    expect(row!.builderFeeUsd).toBe(a.builderFee as never);
    const [acc] = await p.db.select().from(schema.builderFeeAccruals).where(eq(schema.builderFeeAccruals.day, FILLS_DAY));
    expect(acc).toMatchObject({ venue: "hyperliquid", builder: BUILDER.toLowerCase(), fills: 3, unmatchedFills: 1, source: "hl_userfills" });
    expect(Number(acc!.feeUsd)).toBeCloseTo(Number(a.builderFee) + Number(b.builderFee) + Number(c.builderFee), 9);
  });

  test("receipt-without-fill", async () => {
    const day = "2026-11-03";
    const at = Date.parse(`${day}T10:00:00Z`);
    const filled = await p.order({ owner: U, oid: "990000000001", status: "filled", at });
    const partial = await p.order({ owner: U, oid: "990000000002", status: "partial", at });
    await p.order({ owner: U, oid: "990000000003", status: "open", at }); // resting: not expected to fill
    await p.order({ owner: U, oid: "990000000004", status: "cancelled", at });
    const al = collector();
    const r = await reconcileHl(day, { db: p.db, hl: fakeHl({}).hl, builder: BUILDER, csv: fakeCsv({}).csv, publish: al.publish });
    expect(r.receiptsWithoutFill).toEqual([filled.receipt!.receiptId, partial.receipt!.receiptId].sort());
    expect(al.events.find((e) => e.detail.reason === "receipt_without_fill")?.detail.unmatchedFills).toBe(2);
    // once its fill is on record the receipt is matched
    const fill: HlFill = { coin: "BTC", px: "70000", sz: "0.001", side: "B", time: at + 1000, oid: "990000000001", fee: "0.03", builderFee: "0.007", hash: "0x01", tid: 1 };
    const r2 = await reconcileHl(day, { db: p.db, hl: fakeHl({ [U]: [fill] }).hl, builder: BUILDER, csv: fakeCsv({}).csv });
    expect(r2.receiptsWithoutFill).toEqual([partial.receipt!.receiptId]);
  });

  test("partials", async () => {
    const oid = single.multi[0]!;
    const parts = FILLS.filter((f) => String(f.oid) === oid);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const { orderId } = await p.order({ owner: U, oid, marketId: marketOf(parts[0]!.coin) });
    const r = await reconcileHl(FILLS_DAY, { db: p.db, hl: fakeHl({ [U]: FILLS }).hl, builder: BUILDER, csv: fakeCsv({}).csv });
    const rows = await p.db.select().from(schema.fills).where(eq(schema.fills.venueOrderId, oid));
    expect(rows).toHaveLength(parts.length);
    expect(new Set(rows.map((x) => x.orderId))).toEqual(new Set([orderId]));
    expect(new Set(rows.map((x) => x.id)).size).toBe(parts.length);
    expect(r.unmatchedFills.some((id) => rows.some((x) => x.id === id))).toBe(false);
  });

  test("isolation", async () => {
    const day = "2026-11-04";
    const at = Date.parse(`${day}T09:00:00Z`);
    const good = "0x00000000000000000000000000000000000000b2" as Hex; // sorts after `bad`
    const bad = "0x00000000000000000000000000000000000000a1" as Hex;
    await p.order({ owner: bad, oid: "880000000001", status: "open", at });
    await p.order({ owner: good, oid: "880000000002", status: "filled", at });
    const fill: HlFill = { coin: "ETH", px: "3500", sz: "0.1", side: "A", time: at + 5, oid: "880000000002", fee: "0.2", builderFee: "0.035", hash: "0xab", tid: 7 };
    const f = fakeHl({ [good]: [fill] }, [bad]);
    const r = await reconcileHl(day, { db: p.db, hl: f.hl, builder: BUILDER, csv: fakeCsv({}).csv });
    expect(r.failedOwners).toEqual([bad]);
    expect(r.fills).toBe(1);
    expect(r.feeUsd).toBe("0.035");
    const called = f.calls.map((c) => c.owner);
    expect(called).toContain(bad);
    expect(called).toContain(good); // read after the failing owner
  });

  test("bounded", async () => {
    const own = await plant("hl-bounded");
    try {
    const day = "2026-11-06";
    const at = Date.parse(`${day}T01:00:00Z`);
    const owners = Array.from({ length: 60 }, (_, i) => `0x${(0xc000 + i).toString(16).padStart(40, "0")}` as Hex);
    for (const [i, o] of owners.entries()) await own.order({ owner: o, oid: String(770000000000 + i), status: "open", at });
    // the cap: 5 of 60 owners read, the rest left for the next run
    const f = fakeHl({});
    const capped = await reconcileHl(day, { db: own.db, hl: f.hl, builder: BUILDER, csv: fakeCsv({}).csv, maxOwners: 5 });
    expect(f.calls).toHaveLength(5);
    expect(capped.ownersSkipped).toBe(55);

    // the real reader, through the governor at free priority: 60 userFillsByTime calls (weight 20) pass the free
    // lane's 80% of 1,200 per minute, so free waits, while a safety request is granted at once
    let t = 1_800_000_000_000;
    const base = createMemoryGovernor("recon-test", { now: () => t, sleep: async (ms) => void (t += ms) });
    const seen: Priority[] = [];
    let safetyWaited = -1;
    let freeCalls = 0;
    const gov: Governor = {
      ...base,
      egress: base.egress,
      observe: base.observe.bind(base),
      usage: base.usage.bind(base),
      flush: base.flush.bind(base),
      async acquire(v, cost, o) {
        seen.push(o?.priority ?? "free");
        const lease = await base.acquire(v, cost, o);
        if ((o?.priority ?? "free") === "free" && ++freeCalls === 48 && safetyWaited < 0) {
          const before = t;
          await base.acquire("hyperliquid", 20, { priority: "safety" });
          safetyWaited = t - before;
        }
        return lease;
      },
    };
    const fetchImpl = (async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const http = venueHttp("hyperliquid", "https://api.hyperliquid.xyz", gov, { priority: "free", fetchImpl });
    const reader = createHlReader({ ...HL_MAINNET, builderAddress: null }, http, memoryMarketDataCache());
    const start = t;
    const r = await reconcileHl(day, { db: own.db, hl: reader, builder: BUILDER, csv: fakeCsv({}).csv, maxOwners: 5_000 });
    expect(r.failedOwners).toEqual([]);
    expect(seen.length).toBe(60);
    expect(new Set(seen)).toEqual(new Set(["free"]));
    expect(safetyWaited).toBe(0); // safety was never starved
    expect(t - start).toBeGreaterThan(0); // free had to wait for the window
    } finally {
      await own.drop();
    }
  });
});
