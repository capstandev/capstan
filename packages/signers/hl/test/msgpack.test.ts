// R6: msgpack integer sizes and key order.
import { describe, expect, test } from "bun:test";
import { actionHash, actionMsgpack, type HlL1Action, type HlOrderAction } from "../src";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("msgpack", () => {
  test("int-and-order", () => {
    const action: HlOrderAction = { type: "order", orders: [{ a: 110001, b: true, p: "338.3", s: "0.5", r: false, t: { limit: { tif: "Ioc" } }, c: "0x00000000000000000000000000000001" }], grouping: "na" };
    const packed = hex(actionMsgpack(action));
    // "a" (a1 61) followed by uint32 110001 = ce 0001adb1
    expect(packed).toContain("a161ce0001adb1");
    // small ints use the smallest form: 0 -> 00, 127 -> 7f, 128 -> cc80, 65536 -> ce00010000
    for (const [n, want] of [[0, "00"], [127, "7f"], [128, "cc80"], [255, "ccff"], [256, "cd0100"], [65536, "ce00010000"], [100000000000, "cf000000174876e800"]] as const) {
      const h = hex(actionMsgpack({ type: "cancel", cancels: [{ a: n, o: 1 }] }));
      expect(h).toContain(`a161${want}a16f01`);
    }
    // key order of an order wire is a, b, p, s, r, t, c
    const keyBytes = ["a161", "a162", "a170", "a173", "a172", "a174", "a163"];
    let at = -1;
    for (const k of keyBytes) {
      const i = packed.indexOf(k, at + 1);
      expect(i).toBeGreaterThan(at);
      at = i;
    }
    // a reordered object packs differently and hashes differently: order matters
    const o = action.orders[0]!;
    const reordered = { type: "order", orders: [{ b: o.b, a: o.a, p: o.p, s: o.s, r: o.r, t: o.t, c: o.c }], grouping: "na" } as unknown as HlL1Action;
    expect(hex(actionMsgpack(reordered))).not.toBe(packed);
    expect(actionHash(reordered, null, 1)).not.toBe(actionHash(action, null, 1));
    // an absent cloid drops the key entirely (no nil)
    const noC: HlOrderAction = { ...action, orders: [{ ...o, c: undefined }] };
    expect(hex(actionMsgpack(noC))).not.toContain("a163c0");
    expect(hex(actionMsgpack(noC))).not.toContain("a163");
  });
});
