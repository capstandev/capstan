// R8: nonces are ms timestamps, strictly increasing per agent, inside (T - 2 d, T + 1 d).
import { describe, expect, test } from "bun:test";
import { NonceSource } from "../../src";

describe("nonce", () => {
  test("monotonic-window", () => {
    const n = new NonceSource();
    const T = 1793929036000;
    const a = "0x00000000000000000000000000000000000000aa";
    const b = "0x00000000000000000000000000000000000000bb";
    const xs = Array.from({ length: 1000 }, () => n.next(a, T));
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBe(xs[i - 1]! + 1);
    expect(xs[0]).toBe(T);
    expect(n.next(b, T)).toBe(T); // per agent
    expect(n.next(a.toUpperCase().replace("0X", "0x"), T)).toBe(T + 1000); // same agent, any case
    expect(n.next(a, T + 5000)).toBe(T + 5000); // the clock moved past the counter
    expect(n.next(a, T + 4000)).toBe(T + 5001); // never backwards
    // a counter pushed more than a day ahead of the clock is refused
    const c = "0x00000000000000000000000000000000000000cc";
    const fresh = new NonceSource();
    fresh.next(c, T + 86_400_000 - 1);
    expect(() => fresh.next(c, T - 1)).toThrow(/future/);
  });
});
