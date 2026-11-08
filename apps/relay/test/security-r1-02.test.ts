// Security review r1, review-r1:2 R1-02: exit traffic (cancels, closes, reduce-only orders) is still counted by its
// own bounded lane, waits a finite time for venue budget, and one venue's backlog cannot hold the dispatch slots of
// another venue. 200 reduce-only submits from one wallet and one IP on a Lighter market with no budget left must not
// stop another user's Hyperliquid cancel, which goes out within 1 s.
import { afterAll, describe, expect, test } from "bun:test";
import { createMemoryGovernor } from "@capstan/venue-client";
import { CapstanError } from "@capstan/schema";
import { priorityDispatcher, RELAY_MAX_OPEN_JOBS } from "../src/dispatch";
import { EXIT_PER_MIN_IP, EXIT_PER_MIN_WALLET, memoryLaneLimiter } from "../src/lanes";
import { handleSubmit } from "../src/pipeline";
import { RELAY_WORKER_CONCURRENCY } from "../src/queue";
import { codeOf, LIGHTER_OWNER, NOW, relayStack } from "./helpers";

const codeOfErr = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof CapstanError ? e.code : String(e)));

/** Fill `key` with `running` blocked jobs and `waiting` queued ones; returns their outcomes and a release. */
function fill(d: ReturnType<typeof priorityDispatcher>, key: string, priority: "free" | "pro", running: number, waiting: number) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const outcomes: Promise<string | null>[] = [];
  for (let i = 0; i < running + waiting; i++) outcomes.push(codeOfErr(d.run(priority, () => gate, key)));
  return { outcomes, release };
}

const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));

describe("security r1 R1-02", () => {
  test("exit-flood-cannot-stall-other-venues", async () => {
    const governor = createMemoryGovernor("r1-02-egress");
    const s = relayStack({ governor });
    stacks.push(s);
    (s.deps as { safetyBudgetWaitMs?: number }).safetyBudgetWaitMs = 1_500;
    // the production shape: a bounded wait line per venue key (an option unfixed code ignores)
    s.deps.dispatch = (priorityDispatcher as (c: number, o?: { maxQueuedPerKey?: number }) => typeof s.deps.dispatch)(4, { maxQueuedPerKey: 8 });
    // the attacker's Lighter L1 has no submit budget left this minute
    const l1 = `lighter-304:l1:${LIGHTER_OWNER.toLowerCase()}` as const;
    for (;;) {
      try {
        await governor.acquire(l1, 1, { priority: "safety", deadlineMs: 0 });
      } catch {
        break;
      }
    }
    const ip = { ip: "203.0.113.90" };
    const flood: Promise<{ code: string | null }>[] = [];
    for (let i = 0; i < 200; i++) {
      const l = s.lighter({ reduceOnly: true });
      flood.push(codeOf(handleSubmit({ buildId: l.b.buildId, signedEnvelope: l.env }, ip, s.deps)));
    }
    await Bun.sleep(50);
    // another user cancels on Hyperliquid: it must not wait behind the Lighter backlog
    const c = await s.hl({}, { kind: "cancel" });
    const t0 = Date.now();
    const cancel = await Promise.race([codeOf(handleSubmit({ buildId: c.b.buildId, signedEnvelope: c.env }, { ip: "198.51.100.30" }, s.deps)), Bun.sleep(1_000).then(() => "timeout" as const)]);
    expect(cancel).not.toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(s.venues.hl.length).toBe(1);
    // the flood ends in bounded time: most refused by the exit lane at once, the rest by the budget deadline
    const done = await Promise.race([Promise.all(flood), Bun.sleep(10_000).then(() => null)]);
    expect(done).not.toBeNull();
    const codes = done!.map((r) => r.code);
    expect(codes.every((x) => x === "VENUE_RATE_LIMITED")).toBe(true);
    expect(s.venues.lighter.length).toBe(0);
  }, 30_000);

  test("safety-job-is-never-refused-by-a-line-of-opening-jobs", async () => {
    // the verifier's probe: one venue key with 8 running and 16 waiting free jobs, then a safety cancel on that key
    const d = priorityDispatcher(8, { maxQueuedPerKey: 16, safetyReserve: 8 });
    const f = fill(d, "hyperliquid", "free", 8, 16);
    expect(d.pending()).toBe(16);
    let ran = false;
    const cancel = d.run("safety", async () => void (ran = true), "hyperliquid");
    // it starts at once in a reserved slot, while all 8 opening jobs are still running
    await Bun.sleep(0);
    expect(ran).toBe(true);
    await cancel;
    // a new free job on the full line is refused
    expect(await codeOfErr(d.run("free", async () => undefined, "hyperliquid"))).toBe("VENUE_RATE_LIMITED");
    // a full line of 8 safety jobs waiting behind 16 running: the next safety job takes the newest free job's place
    const d2 = priorityDispatcher(2, { maxQueuedPerKey: 3, safetyReserve: 1 });
    const g = fill(d2, "k", "free", 2, 3);
    let release!: () => void;
    const hold = d2.run("safety", () => new Promise<void>((r) => (release = r)), "k"); // the reserved slot
    const s1 = d2.run("safety", async () => "s1", "k"); // waits; the line was full, so the newest free job is refused
    expect(await g.outcomes[4]).toBe("VENUE_RATE_LIMITED");
    expect(d2.pending()).toBe(3);
    release();
    g.release();
    expect(await s1).toBe("s1");
    await hold;
    // the safety job ran before the free jobs that were waiting
    const out = await Promise.all(g.outcomes);
    expect(out.slice(0, 4).every((x) => x === null)).toBe(true);
    expect(d2.order.indexOf("safety", 3)).toBeLessThan(d2.order.lastIndexOf("free"));
    f.release();
    expect((await Promise.all(f.outcomes)).every((x) => x === null)).toBe(true);
  });

  test("pro-takes-a-waiting-free-place-and-full-line-of-pro-refuses-free", async () => {
    const d = priorityDispatcher(1, { maxQueuedPerKey: 2 });
    const f = fill(d, "k", "free", 1, 2);
    let ran = false;
    const pro = d.run("pro", async () => void (ran = true), "k");
    expect(await f.outcomes[2]).toBe("VENUE_RATE_LIMITED");
    f.release();
    await pro;
    expect(ran).toBe(true);
    expect(d.order.slice(0, 2)).toEqual(["free", "pro"]);
  });

  test("opening-jobs-across-venues-never-take-every-slot", async () => {
    // many stalled venue keys: opening jobs are capped across keys, safety jobs on any key still start
    const d = priorityDispatcher(4, { maxQueuedPerKey: 8, maxOpenJobs: 30 });
    const a = fill(d, "lighter-304:l1:0xa", "free", 4, 8);
    const b = fill(d, "lighter-304:l1:0xb", "free", 4, 8);
    const c = fill(d, "lighter-304:l1:0xc", "free", 4, 2);
    expect(d.openJobs()).toBe(30);
    expect(await codeOfErr(d.run("free", async () => undefined, "aster"))).toBe("VENUE_RATE_LIMITED");
    // a pro job takes the newest waiting free job's place (on key c)
    const pro = d.run("pro", async () => "pro", "aster");
    expect(await c.outcomes[5]).toBe("VENUE_RATE_LIMITED");
    expect(await pro).toBe("pro");
    expect(await d.run("safety", async () => "exit", "hyperliquid")).toBe("exit");
    for (const x of [a, b, c]) x.release();
    await Promise.all([...a.outcomes, ...b.outcomes, ...c.outcomes]);
    expect(d.openJobs()).toBe(0);
    // production: worker slots stay above every opening job the dispatcher can hold
    expect(RELAY_WORKER_CONCURRENCY - RELAY_MAX_OPEN_JOBS).toBeGreaterThanOrEqual(64);
  });

  test("cancel-through-the-pipeline-beats-a-full-venue-line", async () => {
    const s = relayStack();
    stacks.push(s);
    const d = priorityDispatcher(8, { maxQueuedPerKey: 16, safetyReserve: 8 });
    s.deps.dispatch = d;
    const f = fill(d, "hyperliquid", "free", 8, 16);
    const c = await s.hl({}, { kind: "cancel" });
    const cancel = await Promise.race([codeOf(handleSubmit({ buildId: c.b.buildId, signedEnvelope: c.env }, { ip: "198.51.100.31" }, s.deps)), Bun.sleep(1_000).then(() => null)]);
    expect(cancel).not.toBeNull();
    expect(cancel!.code).toBeNull();
    expect(s.venues.hl.length).toBe(1);
    f.release();
    await Promise.all(f.outcomes);
  }, 30_000);

  test("exit-lane-counts-per-wallet-and-per-ip", async () => {
    const l = memoryLaneLimiter();
    const take = (wallet: string, ip: string, kind: "cancel" | "close" = "cancel") => l.take({ wallet, ipBucket: ip, lane: "free", perMin: 2, kind, nowMs: NOW });
    for (let i = 0; i < EXIT_PER_MIN_WALLET; i++) expect((await take("0xaa", `203.0.113.${i % 50}`)).ok).toBe(true);
    expect(await take("0xaa", "203.0.113.200", "close")).toMatchObject({ ok: false, reason: "exit_wallet" });
    // one IP bucket across many wallets
    const l2 = memoryLaneLimiter();
    for (let i = 0; i < EXIT_PER_MIN_IP; i++) expect((await l2.take({ wallet: `0x${i.toString(16)}`, ipBucket: "198.51.100.7", lane: "pro", perMin: 1000, kind: "cancel", nowMs: NOW })).ok).toBe(true);
    expect(await l2.take({ wallet: "0xfresh", ipBucket: "198.51.100.7", lane: "pro", perMin: 1000, kind: "close", nowMs: NOW })).toMatchObject({ ok: false, reason: "exit_ip" });
    // and through the pipeline: the wallet's cancel past the exit limit is refused before the venue
    const s = relayStack();
    stacks.push(s);
    s.deps.now = () => NOW;
    let sent = 0;
    for (let i = 0; i <= EXIT_PER_MIN_WALLET; i++) {
      const c = await s.hl({}, { kind: "cancel" });
      s.store.builds.get(c.b.buildId)!.expiresAt = NOW + 30_000;
      const r = await codeOf(handleSubmit({ buildId: c.b.buildId, signedEnvelope: c.env }, { ip: `203.0.113.${i % 100}` }, s.deps));
      if (i < EXIT_PER_MIN_WALLET) expect(r.code).toBeNull();
      else expect(r.code).toBe("VENUE_RATE_LIMITED");
      if (r.code === null) sent++;
    }
    expect(sent).toBe(EXIT_PER_MIN_WALLET);
    expect(s.venues.hl.length).toBe(EXIT_PER_MIN_WALLET);
  }, 30_000);
});
