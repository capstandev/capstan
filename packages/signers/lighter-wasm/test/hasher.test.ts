// R14: a hash-only instance returns the same txHash as a real signer for the same fields: the hash does not depend
// on the key. The hasher exposes no sign, export or key method.
import { describe, expect, test } from "bun:test";
import { createLighterHasher, createLighterSigner } from "../src/index";
import { CHAINS, randomCancel, randomOrder, rng } from "./helpers";

describe("hasher", () => {
  test("hash-is-key-independent", async () => {
    for (const chain of CHAINS) {
      const s = await createLighterSigner(chain);
      s.generateApiKey();
      const h = await createLighterHasher(chain);
      const r = rng(9000 + chain);
      for (let i = 0; i < 200; i++) {
        if (i % 2 === 0) {
          const o = randomOrder(r, 500 + i);
          const signed = await s.signCreateOrder(o);
          expect(await h.txHashForOrder(o)).toBe(signed.txHash);
        } else {
          const c = randomCancel(r, 500 + i);
          const signed = await s.signCancelOrder(c);
          expect(await h.txHashForCancel(c)).toBe(signed.txHash);
        }
      }
      expect(Object.keys(h).sort()).toEqual(["close", "txHashForCancel", "txHashForOrder"]);
      for (const k of Object.keys(h)) expect(k).not.toMatch(/sign|export|import|key/i);
      s.close();
      h.close();
    }
  });

  test("two hashers with different ephemeral keys agree, and a field change changes the hash", async () => {
    const a = await createLighterHasher(304);
    const b = await createLighterHasher(304);
    const o = randomOrder(rng(3), 1);
    const ha = await a.txHashForOrder(o);
    expect(await b.txHashForOrder(o)).toBe(ha);
    expect(await a.txHashForOrder({ ...o, price: o.price + 1 })).not.toBe(ha);
    expect(await a.txHashForOrder({ ...o, expiredAt: o.expiredAt! + 1 })).not.toBe(ha);
    a.close();
    b.close();
  });
});
