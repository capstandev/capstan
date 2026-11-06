// R1 (todo 18): the same hourly economics at 1, 2, 4 and 8 h intervals give the same ratePerHour and rateAnnualised.
import { describe, expect, test } from "bun:test";
import { Dec } from "@capstan/schema";
import { normalise } from "../../src/funding/normalise";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
}

describe("normalise", () => {
  test("cadence-fuzz", () => {
    expect(normalise("0.0001", 28_800)).toEqual({ ratePerHour: "0.0000125", rateAnnualised: "0.1095" });
    expect(normalise("0.00005", 14_400).ratePerHour).toBe("0.0000125");
    expect(normalise("-0.0003", 3600)).toEqual({ ratePerHour: "-0.0003", rateAnnualised: "-2.628" });
    expect(() => normalise("0.1", 0)).toThrow();
    const r = rng(42);
    for (let i = 0; i < 2000; i++) {
      // an hourly rate with up to 12 decimals, either sign
      const digits = String(Math.floor(r() * 1e12)).padStart(12, "0");
      const perHour = `${r() < 0.5 ? "-" : ""}0.${digits}`;
      const h = Dec.parse(perHour, 30);
      const outs = [1, 2, 4, 8].map((k) => normalise(Dec.toString(Dec.mul(h, Dec.parse(String(k), 0), 30)), k * 3600));
      for (const o of outs) {
        expect(o.ratePerHour).toBe(Dec.toString(h));
        expect(o.rateAnnualised).toBe(outs[0]!.rateAnnualised);
      }
      expect(outs[0]!.rateAnnualised).toBe(Dec.toString(Dec.mul(h, Dec.parse("8760", 0), 30)));
    }
  });
});
