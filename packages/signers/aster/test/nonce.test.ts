// R11 (todo 14): microsecond nonces, strictly increasing per signer, refused outside 60 s of server time.
import { describe, expect, test } from "bun:test";
import { AsterNonce, AsterSignError, assertNonceWindow } from "../src";

describe("aster nonce", () => {
  test("monotonic-window", () => {
    const n = new AsterNonce();
    const t = 1_793_921_875_000_000n;
    const a = n.next(t);
    const b = n.next(t); // same clock tick
    const c = n.next(t - 5_000_000n); // clock stepped back
    const d = n.next(t + 1_000_000n);
    expect(a).toBe(t);
    expect(b).toBe(t + 1n);
    expect(c).toBe(t + 2n);
    expect(d).toBe(t + 1_000_000n);
    // fuzz: any clock sequence gives a strictly increasing series
    const m = new AsterNonce();
    let last = 0n;
    for (let i = 0; i < 5000; i++) {
      const jitter = BigInt(Math.floor(Math.random() * 2_000_000) - 1_000_000);
      const v = m.next(t + BigInt(i) * 10n + jitter);
      expect(v > last).toBe(true);
      last = v;
    }
    // window: within 60 s either side of the supplied server time, else refused before signing
    assertNonceWindow(t + 60_000_000n, t);
    assertNonceWindow(t - 60_000_000n, t);
    expect(() => assertNonceWindow(t + 60_000_001n, t)).toThrow(AsterSignError);
    expect(() => assertNonceWindow(t - 60_000_001n, t)).toThrow(AsterSignError);
    const skew = new AsterNonce();
    expect(() => skew.next(t, t + 61_000_000n)).toThrow(AsterSignError); // local clock 61 s behind the server
    expect(skew.peek()).toBeNull(); // a refused nonce is not consumed
    expect(skew.next(t, t + 59_000_000n)).toBe(t);
    expect(() => new AsterNonce().next(0n)).toThrow(AsterSignError);
    // per signer: two instances are independent
    expect(new AsterNonce().next(t)).toBe(t);
  });
});
