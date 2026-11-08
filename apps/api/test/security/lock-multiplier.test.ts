// r1:3 F9: the API rate limiter built its tier from a lock reader hard-coded to zero, so a Lock Holder or Lock Whale
// always got multiplier 1. The limiter now reads the shared CPSTLock reader: 2x for a holder, 5x for a whale.
import { describe, expect, test } from "bun:test";
import { LOCK_THRESHOLDS, type LockReader } from "@capstan/plans";
import type { Hex } from "@capstan/schema";
import { limiterMultiplier } from "../../src/auth/env";

const HOLDER = "0x00000000000000000000000000000000000000a1" as Hex;
const WHALE = "0x00000000000000000000000000000000000000a2" as Hex;
const lock: LockReader = {
  lockedOf: async (o) => ({ amount: o.toLowerCase() === HOLDER ? LOCK_THRESHOLDS.holder : o.toLowerCase() === WHALE ? LOCK_THRESHOLDS.whale : 0n, unlockAt: 0n }),
};

describe("rate limiter lock tiers (r1:3 F9)", () => {
  test("a locked owner gets 2x as a holder and 5x as a whale", async () => {
    const m = limiterMultiplier(null, {}, lock);
    expect(await m({ owner: HOLDER })).toBe(2);
    expect(await m({ owner: WHALE })).toBe(5);
    expect(await m({ owner: "0x00000000000000000000000000000000000000a3" })).toBe(1);
  });
  test("with no lock address or RPC configured the shared reader gives multiplier 1, never another chain's reader", async () => {
    const m = limiterMultiplier(null, { CAPSTAN_NETWORK: "testnet" });
    expect(await m({ owner: HOLDER })).toBe(1);
  });
});
