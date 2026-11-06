// R7: accruals are idempotent per (day, venue, builder): a re-run replaces the row and never doubles fills or fees.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { and, eq } from "drizzle-orm";
import { reconcileAster, reconcileHl, type AsterBuilderReports } from "../../src/reconcile";
import { BUILDER, fakeCsv, fakeHl, FILLS, FILLS_DAY, FILLS_USER, marketOf, PG, plant, type Planted } from "./helpers";

describe.skipIf(!PG)("accruals", () => {
  let p: Planted;
  beforeAll(async () => {
    p = await plant("accruals");
  });
  afterAll(() => p?.drop());

  test("idempotent", async () => {
    const ours = FILLS.slice(0, 40);
    for (const oid of new Set(ours.map((f) => String(f.oid)))) await p.order({ owner: FILLS_USER as Hex, oid, marketId: marketOf(ours.find((f) => String(f.oid) === oid)!.coin) });
    const run = () => reconcileHl(FILLS_DAY, { db: p.db, hl: fakeHl({ [FILLS_USER]: FILLS }).hl, builder: BUILDER, csv: fakeCsv({}).csv });
    const a = await run();
    const b = await run();
    const c = await run();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    const acc = await p.db.select().from(schema.builderFeeAccruals).where(and(eq(schema.builderFeeAccruals.day, FILLS_DAY), eq(schema.builderFeeAccruals.venue, "hyperliquid")));
    expect(acc).toHaveLength(1);
    expect(acc[0]!.fills).toBe(a.fills);
    expect(acc[0]!.feeUsd).toBe(a.feeUsd as never);
    const fills = await p.db.select().from(schema.fills).where(eq(schema.fills.venue, "hyperliquid"));
    expect(fills.length).toBe(a.fills);
    // fewer fills on a later run (one order's fills dropped from the source) replace the row rather than add to it
    const less = await reconcileHl(FILLS_DAY, { db: p.db, hl: fakeHl({ [FILLS_USER]: FILLS.slice(5) }).hl, builder: BUILDER, csv: fakeCsv({}).csv });
    const acc2 = await p.db.select().from(schema.builderFeeAccruals).where(eq(schema.builderFeeAccruals.day, FILLS_DAY));
    expect(acc2).toHaveLength(1);
    expect(acc2[0]!.fills).toBe(less.fills);
    expect(less.fills).toBeLessThan(a.fills);

    // Aster too, and its row sits beside the HL one (one row per venue, nothing netted)
    const reports: AsterBuilderReports = { builder: "0x00000000000000000000000000000000000000ad" as Hex, userCommissions: async () => ({ rows: [{ tradeId: 1, insertTime: Date.parse(`${FILLS_DAY}T05:00:00Z`), orderId: 11, symbol: "BTCUSDT", feeAsset: "USDT", marginAsset: "USDT", builderFee: "0.5", userAddress: FILLS_USER }], hasMore: false }) };
    const now = () => new Date(`${FILLS_DAY}T23:00:00Z`);
    await reconcileAster(FILLS_DAY, { db: p.db, builderReports: reports, now });
    await reconcileAster(FILLS_DAY, { db: p.db, builderReports: reports, now });
    const all = await p.db.select().from(schema.builderFeeAccruals).where(eq(schema.builderFeeAccruals.day, FILLS_DAY));
    expect(all.map((x) => x.venue).sort()).toEqual(["aster", "hyperliquid"]);
    expect(all.find((x) => x.venue === "aster")).toMatchObject({ fills: 1, feeUsd: "0.5", source: "aster_commissions" });
  });
});
