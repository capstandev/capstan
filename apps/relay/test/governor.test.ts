// R8, R16 (todo 30): under a burst of 5,000 submits the fake Hyperliquid sees at most 80% of 1,200 weight in any
// minute, and safety traffic (cancels, close-all) still passes; Lighter submits take both the per-IP and the per-L1
// sendTx buckets, and at the per-IP ceiling a free-lane submit gets the direct-mode hint while a cancel still goes.
import { afterAll, describe, expect, test } from "bun:test";
import { createMemoryGovernor } from "@capstan/venue-client";
import { DIRECT_MODE_HINT } from "../src/lanes";
import { handleSubmit } from "../src/pipeline";
import { codeOf, LIGHTER_OWNER, relayStack } from "./helpers";

const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));

function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("governor", () => {
  test("ceiling-and-safety", async () => {
    const clock = fakeClock();
    const governor = createMemoryGovernor("burst-egress", { now: clock.now, sleep: clock.sleep });
    // one worker: the clock only moves while a submit waits for budget, so arrival time equals grant time
    const s = relayStack({ governor, clock: clock.now, concurrency: 1, proBudgetWaitMs: 3_600_000 });
    stacks.push(s);
    s.deps.lanes = { take: async (o) => ({ ok: true, lane: o.lane }) };
    const made = [];
    for (let i = 0; i < 5000; i++) made.push(await s.hl());
    const out = await Promise.all(made.map((h) => codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: "203.0.113.40" }, s.deps))));
    expect(out.filter((r) => r.code !== null).length).toBe(0);
    const at = s.venues.hl.map((r) => r.at).sort((a, b) => a - b);
    expect(at.length).toBe(5000);
    let worst = 0;
    for (let i = 0, j = 0; i < at.length; i++) {
      while (at[i]! - at[j]! >= 60_000) j++;
      worst = Math.max(worst, i - j + 1); // weight 1 per single-order submit
    }
    expect(worst).toBeLessThanOrEqual(960);
    expect(worst).toBeGreaterThan(900); // the budget is actually used, not idle
    // at the ceiling: a cancel (safety) is granted at once, with no wait on the clock
    for (let i = 0; i < 960 - governor.usage("hyperliquid").used; i++) await governor.acquire("hyperliquid", 1, { priority: "pro" });
    const before = clock.now();
    const c = await s.hl({}, { kind: "cancel" });
    expect((await codeOf(handleSubmit({ buildId: c.b.buildId, signedEnvelope: c.env }, { ip: "203.0.113.40" }, s.deps))).code).toBeNull();
    expect(clock.now()).toBe(before);
    expect(s.venues.hl.length).toBe(5001);
  }, 120_000);

  test("lighter-relay-cap", async () => {
    const clock = fakeClock();
    const governor = createMemoryGovernor("lighter-egress", { now: clock.now, sleep: clock.sleep });
    const s = relayStack({ governor, clock: clock.now, freeBudgetWaitMs: 2000 });
    stacks.push(s);
    s.laneOf.value = async () => ({ lane: "free", perMin: 100 });
    s.deps.lanes = { take: async (o) => ({ ok: true, lane: o.lane }) };
    const l1 = `lighter-304:l1:${LIGHTER_OWNER.toLowerCase()}` as const;
    const first = s.lighter();
    expect((await codeOf(handleSubmit({ buildId: first.b.buildId, signedEnvelope: first.env }, { ip: "203.0.113.50" }, s.deps))).code).toBeNull();
    expect(governor.usage("lighter-304").used).toBe(1);
    expect(governor.usage(l1).used).toBe(1);
    // fill the shared per-IP Lighter budget to its 80% ceiling (48 of 60) with other traffic on this IP
    while (governor.usage("lighter-304").used < 48) await governor.acquire("lighter-304", 1, { priority: "pro" });
    const free = s.lighter();
    const r = await codeOf(handleSubmit({ buildId: free.b.buildId, signedEnvelope: free.env }, { ip: "203.0.113.50" }, s.deps));
    expect(r.code).toBe("VENUE_RATE_LIMITED");
    expect(r.message!.startsWith(DIRECT_MODE_HINT)).toBe(true);
    expect(s.venues.lighter.length).toBe(1);
    // the same payload may be tried again later (nothing was sent), and a cancel passes now
    const cancel = s.lighter({}, "cancel");
    expect((await codeOf(handleSubmit({ buildId: cancel.b.buildId, signedEnvelope: cancel.env }, { ip: "203.0.113.50" }, s.deps))).code).toBeNull();
    expect(s.venues.lighter.length).toBe(2);
    expect(governor.usage(l1).used).toBe(2);
  });
});
