import { describe, expect, test } from "bun:test";
import { ulid, ulidTime } from "../src/ulid";

describe("ulid", () => {
  test("monotonic", () => {
    const t = Date.now() + 10_000_000; // ahead of any id made earlier in this process
    const ids = Array.from({ length: 1000 }, () => ulid(t));
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids); // strictly increasing within one ms
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulidTime(ids[0]!)).toBe(t);
    const later = ulid(t + 1);
    expect(later > ids[999]!).toBe(true);
    expect(ulidTime(later)).toBe(t + 1);
  });

  test("sorts by time", () => {
    const base = Date.now() + 20_000_000;
    const a = ulid(base);
    const b = ulid(base + 5);
    const c = ulid(base + 6);
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });

  test("a clock step back keeps order", () => {
    const x = ulid(Date.now() + 30_000_000);
    const y = ulid(Date.now());
    expect(y > x).toBe(true);
  });
});
