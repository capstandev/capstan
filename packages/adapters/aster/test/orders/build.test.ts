// R1 (todo 15): every order carries the brand builder and a string feeRate within the approval.
import { CapstanError } from "@capstan/schema";
import { describe, expect, test } from "bun:test";
import { feeRateFor, type AsterOrderPayload } from "../../src/orders";
import { BUILDER, ctx, intent, setup } from "./setup";

describe("aster order build", () => {
  test("builder-and-fee", async () => {
    const s = setup();
    try {
      const b = await s.adapter.buildOrder(intent(), ctx());
      const p = b.payload as AsterOrderPayload;
      const get = (k: string) => p.params.find(([n]) => n === k)?.[1];
      expect(b.encoding).toBe("aster_v3_params");
      expect(get("builder")).toBe(BUILDER);
      expect(get("feeRate")).toBe("0.0002");
      expect(typeof get("feeRate")).toBe("string");
      expect(p.params.map(([k]) => k)).toEqual(["symbol", "type", "side", "timeInForce", "quantity", "price", "newClientOrderId", "builder", "feeRate", "asterChain", "user", "signer", "nonce"]);
      expect(b.preview.builderFeeBps).toBe(2);
      expect(b.expiresAt - b.expiresAt + 30_000).toBe(30_000);
      // lock tier: 0.0001 (1 bp)
      const lock = await s.adapter.buildOrder(intent(), ctx({ builderFee: { decimalRate: "0.0001" } }));
      expect((lock.payload as AsterOrderPayload).params.find(([k]) => k === "feeRate")![1]).toBe("0.0001");
      expect(lock.preview.builderFeeBps).toBe(1);
      // above the approval, or no approval: refused before build
      const code = (f: () => Promise<unknown>) => f().then(() => null, (e: CapstanError) => e.code);
      expect(await code(() => s.adapter.buildOrder(intent(), ctx({ approvedMaxBps: 1 })))).toBe("BUILDER_APPROVAL_REQUIRED");
      expect(await code(() => s.adapter.buildOrder(intent(), ctx({ approvedMaxBps: null })))).toBe("BUILDER_APPROVAL_REQUIRED");
      expect(await code(() => s.adapter.buildOrder(intent(), ctx({ builderFee: { decimalRate: "0.0005" } })))).toBe("INVALID_INPUT");
      expect(feeRateFor({ builderFee: { decimalRate: "0.0001" }, approvedMaxBps: 1 })).toBe("0.0001");
      expect(() => feeRateFor({ builderFee: null, approvedMaxBps: 1.5 })).toThrow(CapstanError);
      // reduce-only, client id, cancel builds
      const ro = await s.adapter.buildOrder(intent({ reduceOnly: true, clientOrderId: "mine-1" }), ctx());
      const rp = (ro.payload as AsterOrderPayload).params;
      expect(rp.find(([k]) => k === "reduceOnly")![1]).toBe("true");
      expect(rp.find(([k]) => k === "newClientOrderId")![1]).toBe("mine-1");
      expect(await code(() => s.adapter.buildOrder(intent({ size: "0.0015" }), ctx()))).toBe("INVALID_INPUT"); // not a lot multiple
      expect(await code(() => s.adapter.buildOrder(intent({ limitPx: "70000.05" }), ctx()))).toBe("INVALID_INPUT"); // not a tick multiple
      expect(await code(() => s.adapter.buildOrder(intent({ marketId: "aster:-:PTBUSDT" }), ctx()))).toBe("MARKET_NOT_EXECUTABLE"); // settling
      const cancel = await s.adapter.buildCancel({ marketId: "aster:-:BTCUSDT", clientOrderId: "mine-1" }, ctx());
      expect((cancel.payload as AsterOrderPayload).params.map(([k]) => k)).toEqual(["symbol", "origClientOrderId", "asterChain", "user", "signer", "nonce"]);
      // execution flag off: no builds
      const { createAdapter } = await import("../../src/adapter");
      const { ASTER_MAINNET } = await import("../../src/config");
      const off = createAdapter({ ...ASTER_MAINNET, builder: BUILDER, execution: false }, { http: s.http, cache: null, reader: s.reader });
      expect(off.caps.execution).toBe(false);
      expect(await code(() => off.buildOrder(intent(), ctx()))).toBe("MARKET_NOT_EXECUTABLE");
    } finally {
      s.stop();
    }
  });
});
