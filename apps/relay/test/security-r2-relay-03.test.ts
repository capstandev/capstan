// Security review r2, R2-RELAY-03: a relay killed after sending an order and before recording the answer. BullMQ runs
// the job again only after its 30 s lock lapses, when the build has expired, and under a policy the first run's own row
// counts as usage. The re-run must answer with the first run's row (no BUILD_EXPIRED, no POLICY_BREACH, no refusal
// receipt, nothing sent again) and issue the order receipt; the pending-order sweep then reconciles the row against
// the venue. The second test runs the same thing through a real BullMQ worker that is force-closed mid-submit.
import { afterAll, describe, expect, test } from "bun:test";
import { createRedis } from "@capstan/core";
import { Queue } from "bullmq";
import { BULL_PRIORITY, runRelayJob, startRelayWorker } from "../src/queue";
import { sweepPendingOrders } from "../src/sweep";
import { hlLookup } from "../src/venues";
import type { Dispatcher, RelayVenue } from "../src/types";
import { HL_REF, NOW, policyFor, relayStack } from "./helpers";

const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));
const REDIS = process.env.REDIS_URL;

function setup() {
  const s = relayStack();
  stacks.push(s);
  const ref = "hl:rerun-agent";
  s.store.delegations.set(ref, { ...s.store.delegations.get(HL_REF)!, id: ref });
  // the cap fits exactly one 760 USD order, and the day allows one order
  s.policies.set(ref, { policyId: "pol-rerun", policy: policyFor(ref, { maxGrossNotionalUsd: "1000", maxNotionalPerOrderUsd: "1000", maxOrdersPerDay: 1 }) });
  const clock = { t: NOW };
  s.deps.now = () => clock.t;
  const real = s.deps.dispatch;
  // the process dies right after the venue post: the job never returns and nothing after the send runs
  const dying: Dispatcher = { run: (_p, fn) => (void fn().catch(() => {}), new Promise(() => {})) } as Dispatcher;
  const hlVenue = s.deps.venues.get("hyperliquid")! as RelayVenue;
  const lookups: unknown[] = [];
  const answer = { status: "order", order: { order: { oid: 424242 }, status: "filled" } };
  hlVenue.lookup = hlLookup({ postJson: async (_p: string, body: unknown) => (lookups.push(body), answer) as never });
  return { s, ref, clock, real, dying, lookups };
}

const submits = (s: ReturnType<typeof relayStack>) => s.receipts.all.filter((r) => r.action === "order.submit");
const refusals = (s: ReturnType<typeof relayStack>) => s.receipts.all.filter((r) => r.action === "refusal");

async function until(f: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("security r2 R2-RELAY-03", () => {
  test("re-run-after-expiry-under-a-policy-replays-and-the-sweep-reconciles", async () => {
    const { s, ref, clock, real, dying, lookups } = setup();
    const h = await s.hl({ size: "0.01" }, { agentRef: ref, policyId: "pol-rerun" });
    s.store.builds.get(h.b.buildId)!.expiresAt = clock.t + 30_000;
    const data = { buildId: h.b.buildId, signedEnvelope: h.env, ip: "203.0.113.90" };
    s.deps.dispatch = dying;
    void runRelayJob(data, s.deps);
    await until(() => s.venues.hl.length === 1);
    const row = () => [...s.store.orders.values()].find((o) => o.buildId === h.b.buildId)!;
    expect(row().status).toBe("pending");
    expect(submits(s).length).toBe(0);

    // BullMQ re-runs it after the lock lapses: the build has expired and the row counts against both caps
    s.deps.dispatch = real;
    clock.t += 35_000;
    const again = await runRelayJob(data, s.deps, { rerun: true });
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error(JSON.stringify(again.body));
    expect(again.result.outcome).toBe("unknown");
    expect(again.result.receiptId).not.toBeNull();
    expect(s.venues.hl.length).toBe(1); // never sent twice
    expect(submits(s).length).toBe(1);
    expect(refusals(s).length).toBe(0);
    expect(s.breaches.length).toBe(0);

    // the sweep asks Hyperliquid by cloid and records the answer; the receipt stays the one issued
    clock.t += 11 * 60_000;
    const r = await sweepPendingOrders(s.deps);
    expect(r.settled).toBe(1);
    expect(row()).toMatchObject({ status: "accepted", venueOrderId: "424242" });
    expect(lookups.length).toBe(1);
    expect((lookups[0] as { type: string; oid: string }).type).toBe("orderStatus");
    expect(submits(s).length).toBe(1);
    // settled rows are not read again
    expect((await sweepPendingOrders(s.deps)).checked).toBe(0);
  });

  test("sweep-issues-the-missing-receipt-and-marks-unknown-without-a-venue-read", async () => {
    const { s, clock, dying } = setup();
    const h = s.aster();
    s.deps.dispatch = dying;
    void runRelayJob({ buildId: h.b.buildId, signedEnvelope: h.env, ip: "203.0.113.91" }, s.deps);
    await until(() => s.venues.aster.length === 1);
    clock.t += 4 * 60_000;
    expect((await sweepPendingOrders(s.deps)).receipts).toBe(1); // a receipt now, the row stays pending a while
    expect(submits(s).length).toBe(1);
    clock.t += 10 * 60_000;
    const r = await sweepPendingOrders(s.deps);
    expect(r.markedUnknown).toBe(1);
    expect([...s.store.orders.values()].find((o) => o.buildId === h.b.buildId)!.status).toBe("unknown");
    expect(submits(s).length).toBe(1);
    expect(s.venues.aster.length).toBe(1);
  });

  (REDIS ? test : test.skip)(
    "bullmq-stall-re-run-after-a-killed-worker",
    async () => {
      const { s, ref, clock, real, dying } = setup();
      const prefix = `capstan-sec-r2-${process.pid}-${Date.now()}`;
      const conn = createRedis(REDIS!, { forBullmq: true });
      const q = new Queue("relay-submit", { connection: conn, prefix });
      const h = await s.hl({ size: "0.01" }, { agentRef: ref, policyId: "pol-rerun" });
      s.store.builds.get(h.b.buildId)!.expiresAt = clock.t + 30_000;
      s.deps.dispatch = dying;
      const a = startRelayWorker(createRedis(REDIS!, { forBullmq: true }), s.deps, { prefix, lockDuration: 1500, stalledInterval: 500 });
      let b: ReturnType<typeof startRelayWorker> | undefined;
      try {
        const job = await q.add("relay-submit", { buildId: h.b.buildId, signedEnvelope: h.env, ip: "203.0.113.92" }, { jobId: "r2-relay-03", priority: BULL_PRIORITY.safety, attempts: 1 });
        await until(() => s.venues.hl.length === 1);
        // the process is killed: no lock renewals, nothing after the send
        await a.close(true);
        s.deps.dispatch = real;
        clock.t += 35_000; // the lock lapsed long after the build's 30 s
        b = startRelayWorker(createRedis(REDIS!, { forBullmq: true }), s.deps, { prefix, lockDuration: 1500, stalledInterval: 500 });
        let done: Awaited<ReturnType<typeof job.getState>> = "unknown";
        for (let i = 0; i < 200 && done !== "completed" && done !== "failed"; i++) {
          done = await job.getState();
          await Bun.sleep(100);
        }
        expect(done).toBe("completed");
        const fresh = await q.getJob("r2-relay-03");
        expect(fresh!.returnvalue).toMatchObject({ ok: true, result: { outcome: "unknown" } });
        expect(s.venues.hl.length).toBe(1);
        expect(submits(s).length).toBe(1);
        expect(refusals(s).length).toBe(0);
        clock.t += 11 * 60_000;
        await sweepPendingOrders(s.deps);
        expect([...s.store.orders.values()].find((o) => o.buildId === h.b.buildId)).toMatchObject({ status: "accepted", venueOrderId: "424242" });
        expect(submits(s).length).toBe(1);
      } finally {
        await b?.close();
        await q.obliterate({ force: true }).catch(() => {});
        await q.close();
        await conn.quit().catch(() => {});
      }
    },
    60_000,
  );
});
