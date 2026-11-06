// R5: breakevenHours is null when the funding difference is zero or negative, and cost / diff otherwise (fuzz).
import { describe, expect, test } from "bun:test";
import { breakevenHours } from "../../src";

describe("breakeven", () => {
  test("fuzz", () => {
    let s = 42;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 5000; i++) {
      const cost = Math.round(r() * 100_000) / 1000;
      const diff = (r() - 0.3) * 50;
      const b = breakevenHours(cost, diff);
      if (diff <= 0) expect(b).toBeNull();
      else {
        expect(b).not.toBeNull();
        expect(b!).toBeCloseTo(cost / diff, 9);
        expect(b! * diff).toBeCloseTo(cost, 6);
      }
    }
    expect(breakevenHours(10, 0)).toBeNull();
    expect(breakevenHours(10, -0.0001)).toBeNull();
    expect(breakevenHours(0, 2)).toBe(0);
    expect(breakevenHours(Number.NaN, 2)).toBeNull();
  });
});
