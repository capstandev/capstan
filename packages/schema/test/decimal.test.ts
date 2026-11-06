// R11: Dec fuzz (10,000 cases, fixed seed) plus fixed cases.
import { describe, expect, test } from "bun:test";
import { Dec, divRound, type Rounding } from "../src/decimal";

// xorshift128+ with a fixed seed: deterministic in CI
function rng(seed: number) {
  let a = BigInt(seed) | 1n;
  let b = 0x9e3779b97f4a7c15n;
  const M = (1n << 64n) - 1n;
  return () => {
    let x = a;
    const y = b;
    a = y;
    x ^= (x << 23n) & M;
    b = x ^ y ^ (x >> 17n) ^ (y >> 26n);
    return (b + y) & M;
  };
}
const R = rng(0xca95);
const randInt = (maxExclusive: number) => Number(R() % BigInt(maxExclusive));
const randBig = (digits: number, signed = true) => {
  let s = "";
  const n = 1 + randInt(digits);
  for (let i = 0; i < n; i++) s += String(randInt(10));
  const v = BigInt(s);
  return signed && randInt(2) ? -v : v;
};
const MODES: Rounding[] = ["down", "up", "half_even"];

describe("Dec", () => {
  test("parse and toString", () => {
    expect(Dec.toString(Dec.parse("1.25", 6))).toBe("1.25");
    expect(Dec.toString(Dec.parse("-0.5", 2), { fixed: true })).toBe("-0.50");
    expect(Dec.toString(Dec.parse("3e-4", 6))).toBe("0.0003");
    expect(Dec.toString(Dec.parse("1.5E2", 0))).toBe("150");
    expect(Dec.toString(Dec.parse(".5", 1))).toBe("0.5");
    expect(Dec.toString(Dec.parse("-0", 3))).toBe("0");
    expect(() => Dec.parse("1.234", 2)).toThrow("more than 2 decimals");
    expect(Dec.toString(Dec.parse("1.235", 2, "half_even"))).toBe("1.24");
    expect(Dec.toString(Dec.parse("1.225", 2, "half_even"))).toBe("1.22");
    expect(Dec.toString(Dec.parse("-1.231", 2, "down"))).toBe("-1.24");
    expect(() => Dec.parse("1,5", 2)).toThrow(SyntaxError);
    expect(() => Dec.parse("NaN", 2)).toThrow(SyntaxError);
    expect(() => Dec.parse("", 2)).toThrow(SyntaxError);
    expect(Dec.decimalsOf("0.00100")).toBe(3);
  });

  test("divRound modes", () => {
    expect([divRound(7n, 2n, "down"), divRound(7n, 2n, "up"), divRound(7n, 2n, "half_even")]).toEqual([3n, 4n, 4n]);
    expect([divRound(-7n, 2n, "down"), divRound(-7n, 2n, "up"), divRound(-7n, 2n, "half_even")]).toEqual([-4n, -3n, -4n]);
    expect(divRound(5n, 2n, "half_even")).toBe(2n);
    expect(divRound(-5n, 2n, "half_even")).toBe(-2n);
    expect(() => divRound(1n, 0n, "down")).toThrow("division by zero");
  });

  test("roundToStep examples", () => {
    const step = Dec.parse("0.05", 2);
    expect(Dec.toString(Dec.roundToStep(Dec.parse("1.07", 2), step, "down"))).toBe("1.05");
    expect(Dec.toString(Dec.roundToStep(Dec.parse("1.07", 2), step, "up"))).toBe("1.1");
    expect(Dec.toString(Dec.roundToStep(Dec.parse("-1.07", 2), step, "down"))).toBe("-1.1");
    expect(Dec.toString(Dec.roundToStep(Dec.parse("1.075", 3), step, "half_even"))).toBe("1.1");
    expect(() => Dec.roundToStep(Dec.parse("1", 0), Dec.parse("0", 0), "down")).toThrow("step must be positive");
  });

  test("fuzz", () => {
    for (let i = 0; i < 10_000; i++) {
      const sa = randInt(19);
      const sb = randInt(19);
      const a = Dec.fromBigInt(randBig(30), sa);
      const b = Dec.fromBigInt(randBig(30), sb);
      // add/sub round-trip, and string round-trip
      expect(Dec.eq(Dec.sub(Dec.add(a, b), b), a)).toBe(true);
      expect(Dec.eq(Dec.add(Dec.sub(a, b), b), a)).toBe(true);
      expect(Dec.eq(Dec.parse(Dec.toString(a), sa), a)).toBe(true);
      // mul (exact at the combined scale) then div by the same factor lands within 1 unit at a's scale
      if (b.v !== 0n) {
        const p = Dec.mul(a, b, sa + sb);
        const mode = MODES[randInt(3)]!;
        const back = Dec.div(p, b, sa, mode);
        const diff = back.v - a.v;
        expect(diff >= -1n && diff <= 1n).toBe(true);
        // mul at a coarser scale stays within one unit of the exact product
        const s = randInt(sa + sb + 1);
        const coarse = Dec.mul(a, b, s, mode);
        const exactAtS = Dec.div(p, Dec.parse("1", 0), s, mode);
        expect(coarse.v).toBe(exactAtS.v);
      }
      // roundToStep: a multiple of the step that never crosses the input in its direction
      const step = Dec.fromBigInt(1n + (randBig(6, false) % 100000n), randInt(10));
      for (const mode of MODES) {
        const r = Dec.roundToStep(a, step, mode);
        const s = Math.max(a.scale, step.scale);
        const rv = Dec.rescale(r, s).v;
        const sv = Dec.rescale(step, s).v;
        expect(rv % sv).toBe(0n);
        if (mode === "down") expect(Dec.cmp(r, a) <= 0).toBe(true);
        if (mode === "up") expect(Dec.cmp(r, a) >= 0).toBe(true);
        // never more than one step away
        const dist = Dec.abs(Dec.sub(r, a));
        expect(Dec.cmp(dist, step) <= 0).toBe(true);
        if (mode === "half_even") expect(Dec.cmp(Dec.mul(dist, Dec.parse("2", 0), dist.scale), step) <= 0).toBe(true);
      }
    }
  });
});
