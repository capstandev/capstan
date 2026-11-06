import { afterAll, describe, expect, test } from "bun:test";
import { CapstanError } from "@capstan/schema";
import { BUDGETS, laneCap, type BucketKey, type Priority } from "../src/budgets";
import { acquireLighterSubmit, createGovernorWithStore, redisGovernorStore, slotMsFor, type Lease } from "../src/governor";
import { closeClients, fakeClock, makeGov, redisClient, REDIS_URL, STORE_KINDS, uniqueEgress } from "./helpers";

afterAll(closeClients);

/** Largest total of lease costs inside any window of `windowMs` ending at a lease. */
function maxWindowSum(leases: Lease[], windowMs: number, filter: (l: Lease) => boolean = () => true): number {
  const ls = leases.filter(filter).sort((a, b) => a.at - b.at);
  let max = 0;
  let lo = 0;
  let sum = 0;
  for (let hi = 0; hi < ls.length; hi++) {
    sum += ls[hi]!.cost;
    while (ls[lo]!.at <= ls[hi]!.at - windowMs) sum -= ls[lo++]!.cost;
    max = Math.max(max, sum);
  }
  return max;
}

const hdr = (h: Record<string, string>) => new Headers(h);

for (const kind of STORE_KINDS) {
  describe(`governor (${kind})`, () => {
    test("ceiling-80", async () => {
      const clock = fakeClock();
      const gov = makeGov(kind, clock);
      const leases: Lease[] = [];
      let seed = 7;
      const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
      for (let i = 0; i < 10_000; i++) leases.push(await gov.acquire("hyperliquid", 1 + rnd(20), { priority: rnd(2) ? "pro" : "free" }));
      const cap = BUDGETS.hyperliquid.perWindow * 0.8;
      expect(maxWindowSum(leases, BUDGETS.hyperliquid.windowMs)).toBeLessThanOrEqual(cap);
      // and the budget is actually used (not starved): close to the cap inside the busiest window
      expect(maxWindowSum(leases, BUDGETS.hyperliquid.windowMs)).toBeGreaterThan(cap - 21);
    }, 120_000);

    test("safety-headroom", async () => {
      const clock = fakeClock();
      const gov = makeGov(kind, clock);
      for (let i = 0; i < 96; i++) await gov.acquire("hyperliquid", 10, { priority: "free" }); // 960 = 80%
      await expect(gov.acquire("hyperliquid", 1, { priority: "free", deadlineMs: 0 })).rejects.toThrow(CapstanError);
      await expect(gov.acquire("hyperliquid", 1, { priority: "pro", deadlineMs: 0 })).rejects.toThrow(CapstanError);
      const t0 = clock.t;
      const s = await gov.acquire("hyperliquid", 240, { priority: "safety" }); // the last 20%, no wait
      expect(s.at).toBe(t0);
      await expect(gov.acquire("hyperliquid", 1, { priority: "safety", deadlineMs: 0 })).rejects.toThrow("passes the deadline");
      expect(gov.usage("hyperliquid").used).toBe(1200);
    });

    test("aster-header", async () => {
      const clock = fakeClock(1_800_000_010_000); // 10 s into a UTC minute
      const gov = makeGov(kind, clock);
      await gov.acquire("aster", 1);
      gov.observe("aster", { status: 200, headers: hdr({ "x-mbx-used-weight-1m": "1950" }) }); // 1950/2400 > 80%
      const lease = await gov.acquire("aster", 1);
      const reset = 1_800_000_010_000 - (1_800_000_010_000 % 60_000) + 60_000;
      expect(lease.at).toBeGreaterThanOrEqual(reset);
      // a low header value does not lower our own count
      gov.observe("aster", { status: 200, headers: hdr({ "x-mbx-used-weight-1m": "3" }) });
      expect((await gov.acquire("aster", 1)).at).toBe(clock.t);
    });

    test("aster-418-ban", async () => {
      const clock = fakeClock();
      const gov = makeGov(kind, clock);
      gov.observe("aster", { status: 429, headers: hdr({}) }); // cool-off, default 2 s
      const t0 = clock.t;
      expect((await gov.acquire("aster", 1)).at).toBeGreaterThanOrEqual(t0 + 2000);
      const until = clock.t + 5 * 60_000;
      gov.observe("aster", { status: 418, headers: hdr({}), body: { code: -1003, msg: `Way too many requests; IP banned until ${until}.` } });
      for (let i = 0; i < 3; i++) await expect(gov.acquire("aster", 1, { priority: "safety" })).rejects.toThrow("banned");
      expect(gov.usage("aster").bannedUntil).toBe(until);
      clock.t = until + 1;
      expect((await gov.acquire("aster", 1)).at).toBe(until + 1);
      // with no body hint, Retry-After sets the ban length
      gov.observe("aster", { status: 418, headers: hdr({ "retry-after": "120" }) });
      await expect(gov.acquire("aster", 1)).rejects.toThrow(CapstanError);
      clock.t += 120_000;
      expect((await gov.acquire("aster", 1)).at).toBe(clock.t);
    });

    test("variational-body-retry", async () => {
      const clock = fakeClock();
      const gov = makeGov(kind, clock);
      gov.observe("variational", { status: 429, headers: hdr({}), body: { error: "rate_limited", message: "Service is busy; try again in 1 seconds", retry_after_seconds: 1 } });
      const t0 = clock.t;
      expect((await gov.acquire("variational", 1)).at - t0).toBeGreaterThanOrEqual(1000);
    });

    test("arcus-retry-after", async () => {
      const clock = fakeClock();
      const gov = makeGov(kind, clock);
      gov.observe("arcus", { status: 429, headers: hdr({ "retry-after": "2" }), body: { error: "rate limited" } });
      const t0 = clock.t;
      expect((await gov.acquire("arcus", 20)).at - t0).toBeGreaterThanOrEqual(2000);
    });

    test("lighter-1rps-per-config", async () => {
      const clock = fakeClock();
      const gov = makeGov(kind, clock);
      const a: Lease[] = [];
      const b: Lease[] = [];
      for (let i = 0; i < 10; i++) {
        a.push(await gov.acquire("lighter-304", 1));
        b.push(await gov.acquire("lighter-466324", 1)); // separate bucket: never waits on 304
        expect(b[i]!.at).toBe(a[i]!.at);
      }
      for (let i = 1; i < 10; i++) expect(a[i]!.at - a[i - 1]!.at).toBeGreaterThanOrEqual(1000);
      expect(maxWindowSum(a, 60_000)).toBeLessThanOrEqual(48);
    });

    test("lighter-sendtx-both-buckets", async () => {
      const clock = fakeClock();
      const gov = makeGov(kind, clock);
      const l1 = "0x00000000000000000000000000000000000000Aa";
      const first = await acquireLighterSubmit(gov, "lighter-466324", l1);
      expect(first.map((l) => l.venue)).toEqual(["lighter-466324", `lighter-466324:l1:${l1.toLowerCase()}`]);
      expect(gov.usage("lighter-466324").used).toBe(1);
      expect(gov.usage(`lighter-466324:l1:${l1.toLowerCase()}`).used).toBe(1);
      // the per-L1 bucket (40/min, 80% = 32) binds before the per-IP bucket (60/min at 1 req/s, 80% = 48)
      const leases = [first];
      for (let i = 1; i < 33; i++) leases.push(await acquireLighterSubmit(gov, "lighter-466324", l1));
      const l1Times = leases.map((p) => p[1].at);
      expect(l1Times[32]! - l1Times[0]!).toBeGreaterThanOrEqual(60_000 - slotMsFor(60_000));
      // another L1 on the same config has its own submit bucket but shares the IP bucket (still 1 req/s)
      const other = await acquireLighterSubmit(gov, "lighter-466324", "0x00000000000000000000000000000000000000bb");
      expect(other[1].at - other[0].at).toBe(0);
      // a read on the same config shares the IP bucket with submits
      const read = await gov.acquire("lighter-466324", 1);
      expect(read.at - other[0].at).toBeGreaterThanOrEqual(1000);
    });

    test("free waits behind pro", async () => {
      const clock = fakeClock();
      const gov = makeGov(kind, clock);
      for (let i = 0; i < 8; i++) await gov.acquire("variational", 1); // 8 of 10 = 80%
      const order: Priority[] = [];
      const pro = gov.acquire("variational", 1, { priority: "pro" }).then(() => order.push("pro"));
      await Bun.sleep(1);
      const free = gov.acquire("variational", 1, { priority: "free" }).then(() => order.push("free"));
      await Promise.all([pro, free]);
      expect(order).toEqual(["pro", "free"]);
    });

    test("bad costs are refused", async () => {
      const gov = makeGov(kind, fakeClock());
      await expect(gov.acquire("hyperliquid", 1.5)).rejects.toThrow("non-negative integer");
      await expect(gov.acquire("hyperliquid", laneCap(1200, "free") + 1)).rejects.toThrow("exceeds the free budget");
    });
  });
}

(REDIS_URL ? describe : describe.skip)("governor shared through Redis", () => {
  test("shared-bucket", async () => {
    const clock = fakeClock();
    const egress = uniqueEgress("shared");
    const g1 = createGovernorWithStore(redisGovernorStore(redisClient()), egress, { now: clock.now, sleep: clock.sleep });
    const g2 = createGovernorWithStore(redisGovernorStore(redisClient()), egress, { now: clock.now, sleep: clock.sleep });
    const leases: Lease[] = [];
    for (let i = 0; i < 200; i++) leases.push(await (i % 2 ? g1 : g2).acquire("aster", 10));
    expect(maxWindowSum(leases, 60_000)).toBeLessThanOrEqual(1920);
    // g1 fills the window; g2 (another process on the same IP) sees it at once
    const c2 = fakeClock(clock.t + 600_000);
    const e2 = uniqueEgress("shared2");
    const h1 = createGovernorWithStore(redisGovernorStore(redisClient()), e2, { now: c2.now, sleep: c2.sleep });
    const h2 = createGovernorWithStore(redisGovernorStore(redisClient()), e2, { now: c2.now, sleep: c2.sleep });
    await h1.acquire("aster", 1920);
    await expect(h2.acquire("aster", 1, { deadlineMs: 0 })).rejects.toThrow(CapstanError);
    // a different egress has its own budget
    const other = createGovernorWithStore(redisGovernorStore(redisClient()), uniqueEgress("other"), { now: c2.now, sleep: c2.sleep });
    expect((await other.acquire("aster", 1)).at).toBe(c2.t);
  });
});

describe("budget table", () => {
  test("live limits", () => {
    expect(BUDGETS.hyperliquid).toMatchObject({ unit: "weight", perWindow: 1200, windowMs: 60_000, ceiling: 0.8 });
    expect(BUDGETS["lighter-304"]).toMatchObject({ unit: "request", perWindow: 60, windowMs: 60_000, minIntervalMs: 1000 });
    expect(BUDGETS.aster).toMatchObject({ perWindow: 2400, windowMs: 60_000 });
    expect(BUDGETS.variational).toMatchObject({ unit: "request", perWindow: 10, windowMs: 10_000 });
    expect(BUDGETS.arcus).toMatchObject({ unit: "weight", perWindow: 1500 });
    const keys: BucketKey[] = Object.keys(BUDGETS) as BucketKey[];
    expect(keys.length).toBe(10);
  });
});
