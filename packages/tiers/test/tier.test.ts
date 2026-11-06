// R1: locking is never required (no lock and no key = free, within free limits; free routes answer without either).
// R2: thresholds at 99,999.999 / 100,000 / 1,000,000 CPST, any duration. R3: fail to the lower tier after 10 minutes
// without a good read; a cached value is used for at most 10 minutes. R10: a new wallet with no venue activity gets
// half the free build and relay rate.
import { describe, expect, test } from "bun:test";
import type { Hex } from "@capstan/schema";
import { parseUnits } from "viem";
import { assertCpstDecimals, LIMITS, LOCK_THRESHOLDS, limitsFor, PERK_COPY } from "../src/tiers";
import { tierOf, type LockReader, type WalletActivity } from "../src/tier-of";

const OWNER = "0x00000000000000000000000000000000000000c1" as Hex;
const cpst = (s: string) => parseUnits(s, 18);

function fakeLock(amount: bigint, unlockAt = 0n) {
  const state = { amount, unlockAt, fail: false, calls: 0 };
  const lock: LockReader = {
    async lockedOf() {
      state.calls++;
      if (state.fail) throw new Error("rpc down");
      return { amount: state.amount, unlockAt: state.unlockAt };
    },
  };
  return { lock, state };
}

describe("tiers", () => {
  test("free-without-lock", async () => {
    const { lock } = fakeLock(0n);
    const r = await tierOf({}, { db: null, lock, cacheTtlMs: 60_000 });
    expect(r).toMatchObject({ tier: "free", multiplier: 1, builderFee: { hlTenthsBp: 20, asterRate: "0.0002" }, locked: 0n });
    expect(r.limits).toEqual(LIMITS.free);
    expect(LIMITS.free.relayOrdersPerMinPerWallet).toBe(2); // spec 14 free relay lane
    // an owner with nothing locked is free too; nothing on the free plan depends on CPST
    const r2 = await tierOf({ owner: OWNER }, { db: null, lock, cacheTtlMs: 60_000 });
    expect(r2.tier).toBe("free");
    expect(PERK_COPY.free).toContain("Free plan");
    // the free routes mount and answer with no key and no lock (api app with every route file)
    const { createApp } = await import("../../../apps/api/src/app");
    const { app, routes } = await createApp();
    expect(routes.some((x) => x.path === "/account" && x.auth === "api_key")).toBe(true);
    expect(routes.filter((x) => x.path.startsWith("/credits/topup/")).map((x) => x.auth)).toEqual(["x402", "x402", "x402"]);
    for (const x of routes.filter((r) => r.auth === "public")) {
      if (x.method !== "GET" || x.path.includes(":")) continue;
      const res = await app.request(`/v1${x.path}`);
      expect(res.status, `${x.path}`).not.toBe(401);
      expect(res.status, `${x.path}`).not.toBe(402);
    }
  });

  test("thresholds", async () => {
    const at = async (s: string, unlockAt = 0n) => tierOf({ owner: OWNER }, { db: null, lock: fakeLock(cpst(s), unlockAt).lock, cacheTtlMs: 60_000 });
    expect((await at("99999.999")).tier).toBe("free");
    expect((await at("99999.999999999999999999")).tier).toBe("free");
    const h = await at("100000");
    expect(h).toMatchObject({ tier: "lock_holder", multiplier: 2, builderFee: { hlTenthsBp: 10, asterRate: "0.0001" } });
    expect(h.limits.readsPerMin).toBe(LIMITS.free.readsPerMin * 2);
    expect(h.limits.relayOrdersPerMinPerWallet).toBe(LIMITS.free.relayOrdersPerMinPerWallet * 2);
    expect((await at("999999.999999")).tier).toBe("lock_holder");
    const w = await at("1000000");
    expect(w).toMatchObject({ tier: "lock_whale", multiplier: 5, builderFee: { hlTenthsBp: 10, asterRate: "0.0001" } });
    expect(w.limits.buildsPerMin).toBe(LIMITS.free.buildsPerMin * 5);
    // any lock duration counts: an unlock time already passed (0), 30 days, 90 days
    for (const u of [0n, BigInt(Math.floor(Date.now() / 1000) + 30 * 86400), BigInt(Math.floor(Date.now() / 1000) + 90 * 86400)]) expect((await at("100000", u)).tier).toBe("lock_holder");
    expect(LOCK_THRESHOLDS.holder).toBe(10n ** 23n);
    expect(LOCK_THRESHOLDS.whale).toBe(10n ** 24n);
    // decimals are asserted 18 from the deployment files
    expect(() => assertCpstDecimals({ 4663: { contracts: { CPST: { decimals: 18 } } } })).not.toThrow();
    expect(() => assertCpstDecimals({ 4663: { contracts: { CPST: { decimals: 6 } } } })).toThrow(/18/);
    expect(() => assertCpstDecimals()).not.toThrow();
  });

  test("fail-lower", async () => {
    let now = 1_000_000_000;
    const { lock, state } = fakeLock(cpst("150000"));
    const deps = { db: null, lock, cacheTtlMs: 60_000, now: () => now };
    expect((await tierOf({ owner: OWNER }, deps)).tier).toBe("lock_holder");
    expect(state.calls).toBe(1);
    // within 60 s: cached, no RPC
    now += 30_000;
    await tierOf({ owner: OWNER }, deps);
    expect(state.calls).toBe(1);
    // RPC down: the last good value holds for at most 10 minutes
    state.fail = true;
    now += 5 * 60_000;
    expect((await tierOf({ owner: OWNER }, deps)).tier).toBe("lock_holder");
    now = 1_000_000_000 + 10 * 60_000;
    expect((await tierOf({ owner: OWNER }, deps)).tier).toBe("lock_holder");
    now += 1;
    const late = await tierOf({ owner: OWNER }, deps);
    expect(late).toMatchObject({ tier: "free", multiplier: 1, builderFee: { hlTenthsBp: 20 } });
    // never a good value at all: free
    const never = fakeLock(cpst("2000000"));
    never.state.fail = true;
    expect((await tierOf({ owner: OWNER }, { db: null, lock: never.lock, cacheTtlMs: 60_000 })).tier).toBe("free");
    // recovery: a good read lifts the tier again
    state.fail = false;
    expect((await tierOf({ owner: OWNER }, deps)).tier).toBe("lock_holder");
  });

  test("new-wallet-half-rate", async () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    const activity = (first: string | null, active: boolean): WalletActivity => ({ firstSeen: async () => (first ? new Date(first) : null), hasVenueActivity: async () => active });
    const run = (a: WalletActivity, amount = 0n) => tierOf({ owner: OWNER }, { db: null, lock: fakeLock(amount).lock, cacheTtlMs: 60_000, activity: a, now: () => now });
    const young = await run(activity("2026-11-06T00:00:00Z", false));
    expect(young.newWallet).toBe(true);
    expect(young.limits.buildsPerMin).toBe(LIMITS.free.buildsPerMin / 2);
    expect(young.limits.relayOrdersPerMinPerWallet).toBe(1);
    expect(young.limits.readsPerMin).toBe(LIMITS.free.readsPerMin); // reads are not halved
    expect((await run(activity(null, false))).newWallet).toBe(true); // never seen = new
    expect((await run(activity("2026-11-05T11:59:59Z", false))).newWallet).toBe(false); // older than 24 h
    expect((await run(activity("2026-11-06T11:00:00Z", true))).newWallet).toBe(false); // venue activity
    expect((await run(activity(null, false), cpst("100000"))).newWallet).toBe(false); // a lock is not farming
    const broken: WalletActivity = { firstSeen: async () => Promise.reject(new Error("db")), hasVenueActivity: async () => false };
    expect((await run(broken)).limits.buildsPerMin).toBe(LIMITS.free.buildsPerMin / 2); // unknown history: stricter
    expect(limitsFor("pro", { newWallet: true })).toEqual(LIMITS.pro);
  });
});
