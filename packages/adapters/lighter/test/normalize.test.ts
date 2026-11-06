// R4: prices and sizes are integers scaled by each market's price_decimals / size_decimals; toVenueUnits and
// fromVenueUnits round-trip for 5,000 random values per market and a size is never rounded up.
import { describe, expect, test } from "bun:test";
import { Dec } from "@capstan/schema";
import { fromVenueUnits, MAX_PRICE_UNITS, maxLeverageFromImf, priceToUnits, sizeToUnits, stepOf, toVenueUnits, type LighterDetailRaw } from "../src";
import { fx } from "./helpers";

// deterministic PRNG (mulberry32), fixed seed
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const markets = (["lighter-304", "lighter-466324"] as const).flatMap((v) => {
  const d = fx<{ order_book_details: LighterDetailRaw[]; spot_order_book_details: LighterDetailRaw[] }>(v, "orderBookDetails");
  return [...d.order_book_details, ...d.spot_order_book_details].map((m) => ({ v, m }));
});

describe("normalize", () => {
  test("scaling-fuzz", () => {
    const r = rng(0xc0ffee);
    let checks = 0;
    expect(markets.length).toBeGreaterThan(300);
    for (const { m } of markets) {
      const sd = m.size_decimals!;
      const pd = m.price_decimals!;
      for (let i = 0; i < 5000; i++) {
        // round trip on integers
        const su = Math.floor(r() * 2 ** 40);
        expect(sizeToUnits(fromVenueUnits(su, sd), sd)).toBe(su);
        const pu = Math.floor(r() * MAX_PRICE_UNITS);
        expect(priceToUnits(fromVenueUnits(pu, pd), pd, "half_even")).toBe(pu);
        // a size with extra digits rounds down, never up, and by less than one lot
        if (i % 5 === 0) {
          const extra = `${Math.floor(r() * 1e6)}.${String(Math.floor(r() * 1e12)).padStart(12, "0")}`;
          const u = sizeToUnits(extra, sd);
          const back = Dec.parse(fromVenueUnits(u, sd), 12);
          const exact = Dec.parse(extra, 12);
          expect(Dec.cmp(back, exact)).toBeLessThanOrEqual(0);
          expect(Dec.cmp(Dec.sub(exact, back), Dec.parse(stepOf(sd), 12))).toBe(-1);
          checks++;
        }
        checks += 2;
      }
    }
    expect(checks).toBeGreaterThan(markets.length * 10_000);
  });

  test("ranges, steps and leverage", () => {
    expect(stepOf(0)).toBe("1");
    expect(stepOf(4)).toBe("0.0001");
    expect(() => toVenueUnits("-1", 2, "down")).toThrow();
    expect(() => priceToUnits("99999999999", 2, "down")).toThrow();
    expect(() => toVenueUnits("1", 19, "down")).toThrow();
    expect(priceToUnits("2243.155", 2, "up")).toBe(224316);
    expect(priceToUnits("2243.155", 2, "down")).toBe(224315);
    expect(maxLeverageFromImf(666)).toBe(15);
    expect(maxLeverageFromImf(200)).toBe(50);
    expect(maxLeverageFromImf(0)).toBeNull();
    expect(maxLeverageFromImf(undefined)).toBeNull();
  });
});
