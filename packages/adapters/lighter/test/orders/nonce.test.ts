// R8 (which rejects consume a nonce, and the unknown-outcome check before any re-sign) and R9 (nonces under
// 2^48 - 1, JS-safe, skip jumps of 2^47 - 1 or more refused).
import { describe, expect, test } from "bun:test";
import { CapstanError } from "@capstan/schema";
import { classifySendTx, MAX_NONCE, MAX_SKIP, NonceTracker } from "../../src";

function venue(next: number, found: Set<string> = new Set()) {
  const calls = { nextNonce: 0, tx: 0 };
  return {
    calls,
    set: (n: number) => (next = n),
    src: {
      nextNonce: async () => (calls.nextNonce++, next),
      tx: async (h: string) => (calls.tx++, { found: found.has(h), status: found.has(h) ? 3 : null }),
    },
  };
}

describe("nonces", () => {
  test("reject-classes", async () => {
    const v = venue(100);
    const t = new NonceTracker(v.src);
    await t.seed(7, 4);
    expect([t.next(7, 4), t.next(7, 4), t.next(7, 4), t.next(7, 4)]).toEqual([100, 101, 102, 103]);
    // API server reject: not consumed, resend the same signed tx; the counter does not move
    expect(t.onReject(7, 4, 101, "api")).toEqual({ kind: "resend_same", nonce: 101 });
    // sequencer reject before apply: not consumed, every higher in-flight nonce is re-signed from it
    expect(t.onReject(7, 4, 101, "sequencer_before")).toEqual({ kind: "resign_from", nonce: 101, resign: [102, 103] });
    expect(t.next(7, 4)).toBe(101);
    // applied reject: consumed, a no-op on the venue
    expect(t.onReject(7, 4, 101, "sequencer_applied")).toEqual({ kind: "consumed", nonce: 101 });
    expect(t.next(7, 4)).toBe(102);
    // outcome unknown after a 200: nothing is signed on this key until the tx and nextNonce are checked
    expect(t.onReject(7, 4, 102, "unknown", "aa".repeat(40))).toEqual({ kind: "check_first", nonce: 102 });
    expect(() => t.next(7, 4)).toThrow(/unknown outcome/);
    v.set(102); // the venue never saw it
    expect(await t.resolveUnknown(7, 4, 102)).toBe("not_applied");
    expect(v.calls.tx).toBe(1); // looked up by hash first
    expect(t.next(7, 4)).toBe(102); // re-sign the same nonce
    // the same flow when the tx did land (found by hash): consumed, carry on after it
    const landed = new Set(["bb".repeat(40)]);
    const v2 = venue(500, landed);
    const t2 = new NonceTracker(v2.src);
    await t2.seed(7, 4);
    const n = t2.next(7, 4);
    t2.onReject(7, 4, n, "unknown", "bb".repeat(40));
    v2.set(501);
    expect(await t2.resolveUnknown(7, 4, n)).toBe("consumed");
    expect(t2.next(7, 4)).toBe(501);
    // keys are independent: another key on the same account is not blocked
    await t.seed(7, 5);
    t.onReject(7, 4, 102, "unknown", null);
    expect(() => t.next(7, 4)).toThrow();
    expect(t.next(7, 5)).toBe(102); // seeded from the venue's own nonce for that key
    // the sendTx answer decides which class applies
    expect(classifySendTx(200, { code: 200, tx_hash: "ab" })).toMatchObject({ status: "accepted", txHash: "ab" });
    expect(classifySendTx(200, { code: 200 })).toMatchObject({ status: "unknown" });
    expect(classifySendTx(400, { code: 21120, message: "invalid nonce" })).toMatchObject({ status: "rejected", code: "21120" });
    expect(classifySendTx(503, "")).toMatchObject({ status: "unknown" });
    expect(classifySendTx(null, null, "timeout")).toMatchObject({ status: "unknown", code: "NETWORK" });
  });

  test("bounds", async () => {
    expect(MAX_NONCE).toBe(2 ** 48 - 1);
    expect(Number.isSafeInteger(MAX_NONCE)).toBe(true);
    const t = new NonceTracker(venue(MAX_NONCE - 2).src);
    await t.seed(1, 4);
    expect(t.next(1, 4)).toBe(MAX_NONCE - 2);
    expect(t.next(1, 4)).toBe(MAX_NONCE - 1); // 2^48 - 2, the last nonce under the cap
    expect(() => t.next(1, 4)).toThrow(CapstanError); // the next one would reach 2^48 - 1
    await expect(new NonceTracker(venue(MAX_NONCE).src).seed(1, 4)).rejects.toThrow();
    await expect(new NonceTracker(venue(-1).src).seed(1, 4)).rejects.toThrow();
    await expect(new NonceTracker(venue(1.5).src).seed(1, 4)).rejects.toThrow();
    const s = new NonceTracker(venue(1000).src);
    await s.seed(1, 4);
    expect(() => s.skipTo(1, 4, 1000 + MAX_SKIP)).toThrow(/2\^47/);
    s.skipTo(1, 4, 1000 + MAX_SKIP - 1);
    expect(s.next(1, 4)).toBe(1000 + MAX_SKIP - 1);
    expect(() => s.skipTo(1, 4, 5)).toThrow(/forward/);
    expect(() => new NonceTracker(venue(0).src).next(1, 4)).toThrow(/not seeded/);
    // client order indexes stay inside 1 .. 2^48 - 1 and keep increasing
    const c = new NonceTracker(venue(0).src, () => 1_793_934_000_000);
    await c.seed(1, 4);
    const a = c.nextClientOrderIndex(1, 4);
    const b = c.nextClientOrderIndex(1, 4);
    expect(b).toBeGreaterThan(a);
    expect(a).toBeGreaterThanOrEqual(1);
    expect(b).toBeLessThan(MAX_NONCE);
  });
});
