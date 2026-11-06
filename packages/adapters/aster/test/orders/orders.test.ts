// R12 and R15 (todo 15): no builder fee promised on liquidation paths; close-all from a fresh ingested snapshot.
import type { AccountSnapshot } from "@capstan/schema";
import { describe, expect, test } from "bun:test";
import { fillFeeHint, type AsterOrderPayload } from "../../src/orders";
import { ctx, intent, NOW, owner, setup } from "./setup";

describe("aster orders", () => {
  test("no-fee-on-liquidation", async () => {
    const s = setup();
    try {
      const b = await s.adapter.buildOrderWith(intent({ reduceOnly: true }), ctx(), { liquidationPath: true });
      expect(b.preview.builderFeeBps).toBe(0);
      expect(b.preview.builderFee).toBeNull();
      expect(b.preview.warnings).toContain("liquidation path: no builder fee is charged");
      const normal = await s.adapter.buildOrder(intent({ reduceOnly: true }), ctx());
      expect(normal.preview.builderFeeBps).toBe(2);
      expect(fillFeeHint({ clientOrderId: "autoclose-1793933" })).toEqual({ isLiquidation: true, expectBuilderFee: false });
      expect(fillFeeHint({ clientOrderId: "adl_autoclose" })).toEqual({ isLiquidation: true, expectBuilderFee: false });
      expect(fillFeeHint({ orderType: "LIQUIDATION" }).isLiquidation).toBe(true);
      expect(fillFeeHint({ clientOrderId: "cp01jabc" })).toEqual({ isLiquidation: false, expectBuilderFee: true });
    } finally {
      s.stop();
    }
  });

  test("close-all", async () => {
    const s = setup();
    try {
      const id = { venue: "aster" as const, owner: owner.address };
      const snap: AccountSnapshot = {
        venue: "aster",
        identity: id,
        equityUsd: "1000",
        freeCollateralUsd: "500",
        asOf: new Date(NOW - 10_000).toISOString(),
        positions: [
          { venue: "aster", marketId: "aster:-:BTCUSDT", canonicalAsset: null, side: "long", size: "0.01", entryPx: "70000", markPx: "76000", notionalUsd: "760", leverage: 5, marginMode: "cross", liqPx: "40000", liqPxSource: "venue", marginRatio: null, unrealisedPnlUsd: "60", collateralAsset: "USDT", asOf: "" },
          { venue: "aster", marketId: "aster:-:ETHUSD1", canonicalAsset: null, side: "short", size: "1.5", entryPx: "2300", markPx: "2245", notionalUsd: "3367.5", leverage: 3, marginMode: "isolated", liqPx: null, liqPxSource: "venue", marginRatio: null, unrealisedPnlUsd: "0", collateralAsset: "USD1", asOf: "" },
        ],
      };
      const builds = await s.adapter.buildCloseAll(id, { ...ctx(), snapshot: snap });
      expect(builds.length).toBe(2);
      const p = builds.map((b) => Object.fromEntries((b.payload as AsterOrderPayload).params));
      expect(p.map((x) => [x.symbol, x.side, x.type, x.timeInForce, x.reduceOnly, x.quantity])).toEqual([
        ["BTCUSDT", "SELL", "LIMIT", "IOC", "true", "0.01"],
        ["ETHUSD1", "BUY", "LIMIT", "IOC", "true", "1.5"],
      ]);
      expect(Number(p[0]!.price)).toBeLessThan(76000); // sell bound under the mark
      expect(Number(p[1]!.price)).toBeGreaterThan(2245); // buy bound over the mark
      // no snapshot, a stale one, or another owner's: needs a signed read first
      const code = (x: Promise<unknown>) => x.then(() => null, (e: { reason?: string }) => e.reason);
      expect(await code(s.adapter.buildCloseAll(id, { ...ctx(), snapshot: null }))).toBe("needs_signed_read");
      expect(await code(s.adapter.buildCloseAll(id, { ...ctx(), snapshot: { ...snap, asOf: new Date(NOW - 60_001).toISOString() } }))).toBe("needs_signed_read");
      expect(await code(s.adapter.buildCloseAll(id, { ...ctx(), snapshot: { ...snap, identity: { venue: "aster", owner: "0x1111111111111111111111111111111111111111" } } }))).toBe("needs_signed_read");
      expect(await code(s.adapter.getAccount(id))).toBe("needs_signed_read");
    } finally {
      s.stop();
    }
  });
});
