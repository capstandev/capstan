// BullMQ queue names and the scheduler helper. BullMQ refuses ':' in queue names (checked on bullmq 6.5.4:
// "Queue name cannot contain :"), so the spec's `relay:submit` style names become `relay-submit`.
// BullMQ 6 removed repeatable jobs; every cron is a Job Scheduler with tz UTC.
import { Queue, type Job } from "bullmq";
import type { Redis } from "ioredis";

export const QUEUES = {
  relaySubmit: "relay-submit",
  receiptSign: "receipt-sign",
  // refusal receipts (any stranger can trigger one) sign on their own queue and worker, so a refusal flood never
  // delays an order, claim or kill receipt (security r1 F4)
  receiptSignRefusal: "receipt-sign-refusal",
  // order receipts the relay could not sign in-process right away: the relay (which holds the key) retries them from
  // here with backoff, so a receipt survives a database blip or a relay restart (security r1 R1-07)
  relayReceiptRetry: "relay-receipt-retry",
  anchorHourly: "anchor-hourly",
  catalogSync: "catalog-sync",
  fundingTick: "funding-tick",
  riskRefresh: "risk-refresh",
  riskCompute: "risk-compute",
  spreadScan: "spread-scan",
  reconcileDaily: "reconcile-daily",
  x402Settle: "x402-settle",
  alertsDispatch: "alerts-dispatch", // user webhook alerts only
  opsAlerts: "ops-alerts", // the team's ops alerts, never behind user webhook work (R1-8-03)
  quoteBatch: "quote-batch", // reserved, not used in v1 (quotes run in-process)
} as const;

export type QueueKey = keyof typeof QUEUES;
export type QueueName = (typeof QUEUES)[QueueKey];

export interface Schedule {
  pattern?: string; // cron, evaluated in UTC
  every?: number; // ms
}

export function createQueue(key: QueueKey, connection: Redis, prefix = "capstan"): Queue {
  return new Queue(QUEUES[key], { connection, prefix });
}

/** Create or update a Job Scheduler. Calling it twice with the same id leaves exactly one scheduler. */
export async function upsertSchedule(q: Queue, id: string, s: Schedule, data: Record<string, unknown> = {}): Promise<void> {
  if ((s.pattern === undefined) === (s.every === undefined)) throw new Error("upsertSchedule: give exactly one of pattern or every");
  const repeat = s.pattern !== undefined ? { pattern: s.pattern, tz: "UTC" } : { every: s.every! };
  await q.upsertJobScheduler(id, repeat, { name: id, data, opts: { removeOnComplete: 1000, removeOnFail: 5000 } });
}

export type { Job, Queue };
