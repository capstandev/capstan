// Release gate 2026-11-08 G-2: after a nonce was given back out of order, refresh() reset `next` to the venue's
// nextNonce and dropped every reservation, fresh ones too, so a nonce still held by a live build was handed out again
// and one of the two orders then failed at the venue. Now only stale reservations are dropped and next() skips held ones.
import { describe, expect, test } from "bun:test";
import { NonceTracker, RESERVATION_TTL_MS } from "../../src";

const NOW = 1_800_000_000_000;
const venue = (start: number) => {
  const v = { next: start };
  return { v, src: { nextNonce: async () => v.next, tx: async () => ({ found: false, status: null }) } };
};

describe("gate G-2: live reservations survive a refresh", () => {
  test("gap: a fresh nonce above the gap is never handed out twice", async () => {
    const { src } = venue(10);
    const t = new NonceTracker(src, () => NOW);
    await t.seed(1, 4);
    const held = [t.next(1, 4), t.next(1, 4), t.next(1, 4)]; // 10, 11, 12: three live builds
    t.release(1, 4, 11); // the middle build was refused
    await t.refresh(1, 4);
    const after = [t.next(1, 4), t.next(1, 4)];
    expect(after).toEqual([11, 13]); // the gap is filled, 10 and 12 stay with their builds
    for (const n of after) expect([10, 12]).not.toContain(n);
    expect(new Set([...held.filter((n) => n !== 11), ...after]).size).toBe(4);
  });

  test("stale: a dead reservation is reused, a fresh one above it is kept", async () => {
    const { src } = venue(20);
    let clock = NOW;
    const t = new NonceTracker(src, () => clock);
    await t.seed(1, 4);
    expect(t.next(1, 4)).toBe(20); // built, never sent
    clock += RESERVATION_TTL_MS - 5_000;
    expect(t.next(1, 4)).toBe(21); // a live build
    clock += 10_000; // 20 is past its build life, 21 is not
    await t.refresh(1, 4);
    expect(t.next(1, 4)).toBe(20);
    expect(t.next(1, 4)).toBe(22);
  });
});
