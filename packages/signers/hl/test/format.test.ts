// R9: price formatting fuzz (2,000 cases) plus size rounding.
import { describe, expect, test } from "bun:test";
import { allowedPriceDecimals, formatPrice, formatSize } from "../src";
import { pick, prng, randInt } from "./helpers";

function toScaled(x: string, scale: number): bigint {
  const [i, f = ""] = x.split(".");
  return BigInt(i! + (f + "0".repeat(scale)).slice(0, scale));
}
function sigFigs(x: string): number {
  return x.replace(".", "").replace(/^0+/, "").replace(/0+$/, "").length;
}

describe("format", () => {
  test("price-fuzz", () => {
    const r = prng(7);
    for (let n = 0; n < 2000; n++) {
      const szDecimals = randInt(r, 0, 5);
      const whole = pick(r, [0, 0, randInt(r, 1, 9), randInt(r, 10, 999), randInt(r, 1000, 99999), randInt(r, 100000, 2000000)]);
      const frac = `${randInt(r, 0, 99999999)}`.padStart(randInt(r, 1, 9), "0");
      const px = whole === 0 && /^0+$/.test(frac) ? "0.0001" : `${whole}.${frac}`;
      const dir = pick(r, ["up", "down"] as const);
      const maxDec = 6 - szDecimals;
      if (dir === "down" && toScaled(px, 12) < 10n ** BigInt(12 - maxDec)) {
        // below one tick: rounding down would give zero, which the venue refuses
        expect(() => formatPrice(px, szDecimals, dir)).toThrow(/zero/);
        continue;
      }
      const out = formatPrice(px, szDecimals, dir);
      const isInt = !out.includes(".");
      const decs = isInt ? 0 : out.split(".")[1]!.length;
      if (!isInt) {
        expect(sigFigs(out)).toBeLessThanOrEqual(5);
        expect(out.endsWith("0")).toBe(false);
      }
      expect(decs).toBeLessThanOrEqual(6 - szDecimals);
      // direction and one-tick bound, compared at a common scale
      const S = 12;
      const a = toScaled(px, S);
      const b = toScaled(out, S);
      if (dir === "up") expect(b >= a).toBe(true);
      else expect(b <= a).toBe(true);
      // the tick is the unit of the last allowed decimal at the input's size
      const tick = 10n ** BigInt(S - allowedPriceDecimals(px, szDecimals));
      const diff = b > a ? b - a : a - b;
      expect(diff <= tick).toBe(true);
    }
    expect(formatPrice("76000.123", 5)).toBe("76000");
    expect(formatPrice("1670.1", 4)).toBe("1670.1");
    expect(formatPrice("0.000012345678", 0)).toBe("0.000012");
    expect(formatPrice("1234567", 2)).toBe("1234567");
    expect(formatPrice("9.99999", 2, "up")).toBe("10");
    expect(formatPrice("338.30", 2)).toBe("338.3");
  });

  test("size-round-down", () => {
    expect(formatSize("0.0147", 4)).toBe("0.0147");
    expect(formatSize("0.01479", 4)).toBe("0.0147");
    expect(formatSize("1.50000", 3)).toBe("1.5");
    expect(formatSize("12", 0)).toBe("12");
    expect(() => formatSize("0.00001", 3)).toThrow();
  });
});
