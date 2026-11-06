// R7: funding cost is sign-aware and symmetric.
import { describe, expect, test } from "bun:test";
import { fundingCostBps } from "../src/funding-cost";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("funding", () => {
  test("sign-fuzz", () => {
    // a long with positive funding pays; a short with positive funding receives
    expect(fundingCostBps("0.0000125", 8, "buy")).toBe(1);
    expect(fundingCostBps("0.0000125", 8, "sell")).toBe(-1);
    expect(fundingCostBps("-0.0001", 2, "buy")).toBe(-2);
    expect(fundingCostBps("-0.0001", 2, "sell")).toBe(2);
    expect(Object.is(fundingCostBps("0.0005", 0, "buy"), 0)).toBe(true);
    expect(Object.is(fundingCostBps("0.0005", 0, "sell"), 0)).toBe(true);
    expect(Object.is(fundingCostBps("0", 5, "sell"), 0)).toBe(true);
    const r = rng(17);
    for (let i = 0; i < 5000; i++) {
      const mag = Math.floor(r() * 1e9);
      const rate = `${r() < 0.5 ? "-" : ""}0.${String(mag).padStart(10, "0")}`;
      const hold = Math.floor(r() * 24 * 30 * 4) / 4; // up to 30 days in quarter hours
      const b = fundingCostBps(rate, hold, "buy");
      const s = fundingCostBps(rate, hold, "sell");
      expect(b).toBe(s === 0 ? 0 : -s);
      if (hold > 0 && b !== 0) expect(Math.sign(b)).toBe(rate.startsWith("-") ? -1 : 1);
      expect(Number.isFinite(b)).toBe(true);
    }
  });
});
