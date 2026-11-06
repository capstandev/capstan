// R12: receipt draft fields (spec 11).
import { describe, expect, test } from "bun:test";
import { buildOrder, payloadHash, sha256Jcs, toReceiptDraft } from "../../src";
import { BUILDER, book, ctx, setup, sign, T0, USER_A } from "./util";

describe("receipt", () => {
  test("draft-fields", async () => {
    const { deps, cache } = setup();
    await cache.putBook(book("hyperliquid:-:BTC", 76000, T0));
    for (const f of [20, 10]) {
      const b = await buildOrder({ marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 }, ctx({ builderFee: { tenthsBp: f }, policyId: "pol-1" }), deps);
      const env = sign(b);
      const resp = { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.001", avgPx: "76001.0", oid: 99887766 } }] } } };
      const d = toReceiptDraft(b, env, resp);
      expect(d.builder).toEqual({ address: BUILDER, feeBps: f / 10, rawUnit: `f=${f}` });
      expect(d.signedPayloadHash).toBe(payloadHash(env.signedBody));
      expect(d.signedPayloadHash).toBe(env.payloadHash);
      expect(d.venueOrderId).toBe("99887766");
      expect(d.venueResponseHash).toBe(sha256Jcs(resp));
      expect(d.action).toBe("order.submit");
      expect(d.owner).toBe(USER_A);
      expect(d.venue).toBe("hyperliquid");
      expect(d.marketId).toBe("hyperliquid:-:BTC");
      expect(d.buildId).toBe(b.buildId);
      expect(d.eligibilityDecisionId).toBe("elig-test");
      expect(d.policyId).toBe("pol-1");
      expect(d.quoteSnapshotHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(d.requestHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(d.txHash).toBeNull();
    }
  });
});
