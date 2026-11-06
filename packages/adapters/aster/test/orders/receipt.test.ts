// R10 (todo 15): receipt draft fields.
import { describe, expect, test } from "bun:test";
import { BUILDER, ctx, intent, setup } from "./setup";

describe("aster receipt draft", () => {
  test("draft-fields", async () => {
    const s = setup();
    try {
      const b = await s.adapter.buildOrder(intent(), ctx());
      const r = s.adapter.toReceiptDraft(b, { status: "accepted", venueOrderId: "9007199254740993", txHash: null, venueResponse: { orderId: "9007199254740993" } });
      expect(r).toMatchObject({ action: "order.submit", venue: "aster", marketId: "aster:-:BTCUSDT", buildId: b.buildId, venueOrderId: "9007199254740993", eligibilityDecisionId: "elig_test" });
      expect(r.builder).toEqual({ address: BUILDER, feeBps: 2, rawUnit: "feeRate=0.0002" });
      const lock = await s.adapter.buildOrder(intent(), ctx({ builderFee: { decimalRate: "0.0001" } }));
      expect(s.adapter.toReceiptDraft(lock, { status: "accepted", venueOrderId: "1", txHash: null, venueResponse: {} }).builder).toEqual({ address: BUILDER, feeBps: 1, rawUnit: "feeRate=0.0001" });
      const cancel = await s.adapter.buildCancel({ marketId: "aster:-:BTCUSDT", venueOrderId: "1" }, ctx());
      expect(s.adapter.toReceiptDraft(cancel, { status: "accepted", venueOrderId: "1", txHash: null, venueResponse: {} })).toMatchObject({ action: "order.cancel", builder: null });
    } finally {
      s.stop();
    }
  });
});
