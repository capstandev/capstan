// Security review r1, review-r1:2 R1-07: a submit that reached the venue must never come back INTERNAL_ERROR. When
// the receipt cannot be issued right away, the order row still gets the venue's status and order id, and the answer
// carries the order with the receipt marked pending (the receipt job keeps retrying).
import { afterAll, describe, expect, test } from "bun:test";
import { createRedis } from "@capstan/core";
import type { ReceiptDraft } from "@capstan/receipts";
import type { Receipt } from "@capstan/schema";
import { isRerun, runRelayJob } from "../src/queue";
import { receiptJobId, receiptRetryQueue, retryingReceipts } from "../src/wire";
import { relayStack } from "./helpers";

const DRAFT = { action: "order.submit", requestHash: `0x${"ab".repeat(32)}`, buildId: "01JR107DRAFT0000000000000", owner: null, eligibilityDecisionId: "elig-r107" } as unknown as ReceiptDraft;
const RECEIPT = { receiptId: "r-r107" } as Receipt;

const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));

describe("security r1 R1-07", () => {
  test("receipt-failure-after-accepted-submit", async () => {
    const s = relayStack();
    stacks.push(s);
    const real = s.deps.receipts.issue.bind(s.deps.receipts);
    // receipt-sign is slow or down: every order receipt throws (refusals would still go through)
    s.deps.receipts = { issue: async (d) => (d.action === "refusal" ? real(d) : Promise.reject(new Error("receipt-sign timed out after 10000 ms"))) };
    const h = await s.hl();
    const r = await runRelayJob({ buildId: h.b.buildId, signedEnvelope: h.env, ip: "203.0.113.77" }, s.deps);
    expect(s.venues.hl.length).toBe(1); // the order reached the venue
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.outcome).toBe("accepted");
    expect(r.result.order.venueOrderId).not.toBe("");
    expect(r.result.receiptPending).toBe(true);
    const row = [...s.store.orders.values()].find((x) => x.buildId === h.b.buildId)!;
    expect(row.status).toBe("accepted");
    expect(row.venueOrderId).toBe(r.result.order.venueOrderId);
  });

  test("stalled-job-re-run-answers-with-the-first-run-and-never-resends", async () => {
    const s = relayStack();
    stacks.push(s);
    const h = await s.hl();
    const data = { buildId: h.b.buildId, signedEnvelope: h.env, ip: "203.0.113.78" };
    const first = await runRelayJob(data, s.deps);
    expect(first.ok).toBe(true);
    expect(s.venues.hl.length).toBe(1);
    // BullMQ runs the stalled job again: the answer is the first run's record, nothing is sent twice
    const again = await runRelayJob(data, s.deps, { rerun: true });
    expect(again.ok).toBe(true);
    if (!again.ok || !first.ok) return;
    expect(again.result.outcome).toBe("accepted");
    expect(again.result.order.venueOrderId).toBe(first.result.order.venueOrderId);
    expect(s.venues.hl.length).toBe(1);
    // a fresh request with the same payload is still a duplicate (the dedupe contract is unchanged)
    const dup = await runRelayJob(data, s.deps);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.body.error.code).toBe("DUPLICATE_PAYLOAD");
    expect(s.venues.hl.length).toBe(1);

    // the first run stopped after the row and before the venue answer: the re-run says unknown and does not send
    const h2 = await s.hl();
    const row = { id: "ord-stalled", buildId: h2.b.buildId, venue: "hyperliquid" as const, marketId: h2.b.preview.marketId, owner: h2.s.owner, signedPayloadHash: h2.env.payloadHash, mode: "relay" as const, status: "pending", builderFeeBps: 0, submittedAt: new Date() };
    expect(await s.store.insertOrder(row)).toBe(true);
    const r2 = await runRelayJob({ buildId: h2.b.buildId, signedEnvelope: h2.env, ip: "203.0.113.78" }, s.deps, { rerun: true });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.result.outcome).toBe("unknown"); // the receipt is issued now (R2-RELAY-03)
    expect(s.venues.hl.length).toBe(1);
  });

  test("is-rerun-reads-the-bullmq-counters", () => {
    expect(isRerun({ attemptsStarted: 1, stalledCounter: 0, attemptsMade: 0 })).toBe(false);
    expect(isRerun({ attemptsStarted: 2, stalledCounter: 0, attemptsMade: 0 })).toBe(true);
    expect(isRerun({ attemptsStarted: 1, stalledCounter: 1, attemptsMade: 0 })).toBe(true);
  });

  test("in-process-receipt-failure-is-queued-for-retry", async () => {
    let fail = true;
    let issued = 0;
    const primary = { issue: async () => (fail ? Promise.reject(new Error("db down")) : (issued++, RECEIPT)) };
    const queued: string[] = [];
    const r = retryingReceipts(primary, { enqueue: async (d) => (queued.push(receiptJobId(d)), receiptJobId(d)) });
    const e = (await r.issue(DRAFT).catch((x) => x)) as { receiptJob?: string };
    expect(e.receiptJob).toBe(receiptJobId(DRAFT));
    expect(queued).toEqual([receiptJobId(DRAFT)]);
    expect(r.retrying()).toBe(0);
    // Redis cannot take it either: the relay retries inline until the receipt issues
    const sleeps: number[] = [];
    let tries = 0;
    const flaky = { issue: async () => (++tries < 3 ? Promise.reject(new Error("db down")) : (issued++, RECEIPT)) };
    const r2 = retryingReceipts(flaky, { enqueue: async () => Promise.reject(new Error("redis down")), sleep: async (ms) => void sleeps.push(ms) });
    const e2 = (await r2.issue(DRAFT).catch((x) => x)) as Error & { receiptJob?: string };
    expect(e2.receiptJob).toBeUndefined();
    for (let i = 0; i < 20 && r2.retrying() > 0; i++) await Bun.sleep(1);
    expect(tries).toBe(3);
    expect(sleeps).toEqual([2_000, 4_000]);
    expect(issued).toBe(1);
    fail = false;
  });

  (process.env.REDIS_URL ? test : test.skip)("receipt-retry-queue-issues-the-receipt-after-a-failure", async () => {
    const conn = createRedis(process.env.REDIS_URL!, { forBullmq: true });
    const prefix = `r107-${Date.now()}`;
    const q = receiptRetryQueue(conn, { prefix, delayMs: 0 });
    let calls = 0;
    const got: string[] = [];
    // the primary fails once more inside the worker, then issues: the job's backoff retries it
    const primary = { issue: async (d: ReceiptDraft) => (++calls < 2 ? Promise.reject(new Error("still down")) : (got.push(d.requestHash), RECEIPT)) };
    const w = q.worker(primary);
    try {
      const id = await q.enqueue(DRAFT);
      expect(id).toBe(receiptJobId(DRAFT));
      // the same draft again keeps one job
      expect(await q.enqueue(DRAFT)).toBe(id);
      for (let i = 0; i < 100 && got.length === 0; i++) await Bun.sleep(100);
      expect(got).toEqual([DRAFT.requestHash]);
    } finally {
      await w.close();
      await q.close();
      await conn.quit();
    }
  }, 30_000);
});
