// R1: pickKeyIndex never returns 0, 1, 2, 3, 157 or 255 (10,000 random used-sets), returns the lowest free index and
// throws when all 250 usable slots are taken.
import { describe, expect, test } from "bun:test";
import { CapstanError } from "@capstan/schema";
import { isUsableKeyIndex, pickKeyIndex, RESERVED_KEY_INDEXES, usedKeyIndexes } from "../../src";

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

describe("key index", () => {
  test("reserved-never", () => {
    expect([...RESERVED_KEY_INDEXES]).toEqual([0, 1, 2, 3, 157, 255]);
    const usable = Array.from({ length: 256 }, (_, i) => i).filter(isUsableKeyIndex);
    expect(usable.length).toBe(250);
    const r = rng(42);
    for (let n = 0; n < 10_000; n++) {
      const used = Array.from({ length: Math.floor(r() * 260) }, () => Math.floor(r() * 256));
      const set = new Set(used);
      let got: number | null = null;
      try {
        got = pickKeyIndex(used);
      } catch (e) {
        expect((e as CapstanError).code).toBe("LIGHTER_KEY_INDEX_EXHAUSTED");
        expect(usable.every((i) => set.has(i))).toBe(true);
        continue;
      }
      expect(RESERVED_KEY_INDEXES as readonly number[]).not.toContain(got);
      expect(set.has(got)).toBe(false);
      expect(got).toBe(usable.find((i) => !set.has(i))!); // the lowest free one
    }
    expect(pickKeyIndex([])).toBe(4);
    expect(pickKeyIndex([4, 5, 6])).toBe(7);
    expect(pickKeyIndex(Array.from({ length: 153 }, (_, i) => i + 4))).toBe(158); // 4..156 taken, 157 skipped
    expect(() => pickKeyIndex(usable)).toThrow(CapstanError);
    // unused slots come back with an all-zero key: they are free
    expect(usedKeyIndexes([{ apiKeyIndex: 4, publicKey: "0".repeat(80) }, { apiKeyIndex: 5, publicKey: "ab".repeat(40) }])).toEqual([5]);
  });
});
