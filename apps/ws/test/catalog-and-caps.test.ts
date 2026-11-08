// R2-GW-1: a database error on the catalog read was an unhandled rejection in the subscribe path that could exit the
// ws gateway. The catalog now keeps the last good copy, shares one read between callers and never rejects.
// r1:3 F9: the WS subscription cap used a lock reader hard-coded to zero; a locked owner now gets its tier's cap.
import { describe, expect, test } from "bun:test";
import { LIMITS, LOCK_THRESHOLDS, type LockReader } from "@capstan/plans";
import type { Hex } from "@capstan/schema";
import { catalogReader, wsCapOf } from "../src/caps";

const rows = [{ id: "hyperliquid:-:BTC", asset: "CR:BTC" }];

describe("ws catalog (R2-GW-1)", () => {
  test("a failed read keeps the last good catalog and never rejects", async () => {
    let t = 0;
    let fail = false;
    let reads = 0;
    const cat = catalogReader(async () => (reads++, fail ? Promise.reject(new Error("db down")) : rows), { ttlMs: 60_000, now: () => t });
    expect((await cat()).markets.has("hyperliquid:-:BTC")).toBe(true);
    fail = true;
    t = 120_000;
    const after = await cat();
    expect(after.markets.has("hyperliquid:-:BTC")).toBe(true);
    expect(reads).toBe(2);
  });
  test("with no good copy a failed read answers an empty catalog (unknown ids refused), not a rejection", async () => {
    const cat = catalogReader(async () => Promise.reject(new Error("db down")), { ttlMs: 60_000 });
    const c = await cat();
    expect(c.markets.size).toBe(0);
    expect(c.assets.size).toBe(0);
  });
  test("concurrent callers share one read", async () => {
    let reads = 0;
    const cat = catalogReader(async () => (reads++, await Bun.sleep(5), rows), { ttlMs: 60_000 });
    await Promise.all([cat(), cat(), cat(), cat()]);
    expect(reads).toBe(1);
  });
});

describe("ws subscription caps by lock tier (r1:3 F9)", () => {
  const HOLDER = "0x00000000000000000000000000000000000000b1" as Hex;
  const lock: LockReader = { lockedOf: async (o) => ({ amount: o.toLowerCase() === HOLDER ? LOCK_THRESHOLDS.holder : 0n, unlockAt: 0n }) };
  test("a lock holder gets the lock_holder cap; anonymous gets the configured cap", async () => {
    const capOf = wsCapOf({ db: null, lock, defaultCap: LIMITS.free.wsSubs });
    expect(await capOf(HOLDER)).toBe(LIMITS.lock_holder.wsSubs);
    expect(LIMITS.lock_holder.wsSubs).toBeGreaterThan(LIMITS.free.wsSubs);
    expect(await capOf(null)).toBe(LIMITS.free.wsSubs);
    expect(await capOf("0x00000000000000000000000000000000000000b2" as Hex)).toBe(LIMITS.free.wsSubs);
  });
});

describe("a throwing dependency in the subscribe path (R2-GW-1)", () => {
  test("answers an error frame and leaves no unhandled rejection", async () => {
    const { startWs, client } = await import("./helpers");
    const rejections: unknown[] = [];
    const onRej = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onRej);
    const g = await startWs({ knownMarket: async () => Promise.reject(new Error("db down")) });
    try {
      const c = await client(g.url);
      c.send({ op: "sub", channel: "book:hyperliquid:-:BTC" });
      expect(await c.next((m) => m.type === "error")).toMatchObject({ type: "error", code: "INTERNAL_ERROR" });
      await Bun.sleep(20);
      expect(rejections).toEqual([]);
      c.ws.close();
    } finally {
      process.off("unhandledRejection", onRej);
      g.stop();
    }
  });
});
