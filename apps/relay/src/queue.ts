// The relay-submit queue. The api route enqueues { buildId, signedEnvelope, ip, apiKey } with the lane priority and
// waits up to 10 s for the answer (then returns { status: 'queued', buildId }); the relay process consumes the queue
// and runs the pipeline. One job per payload hash (job id), so a retried HTTP request never makes a second job.
import { QUEUES, type Redis } from "@capstan/core";
import { CapstanError, errorBody, type ErrorBody, type SignedEnvelope } from "@capstan/schema";
import type { Priority } from "@capstan/venue-client";
import { traceFromJob, traceJobData } from "@capstan/telemetry";
import { Queue, QueueEvents, Worker, type Job } from "bullmq";
import { handleSubmit } from "./pipeline";
import type { RelayDeps, SubmitOutcome } from "./types";

export interface RelayJobData {
  buildId: string;
  signedEnvelope: SignedEnvelope;
  ip: string;
  apiKey?: string;
  /** W3C traceparent of the api request that enqueued the job (the relay continues that trace). */
  traceparent?: string;
}

export type RelayJobResult = { ok: true; result: SubmitOutcome } | { ok: false; status: number; body: ErrorBody };

export const BULL_PRIORITY: Record<Priority, number> = { safety: 1, pro: 2, free: 3 };

/** Run one job through the pipeline and turn any refusal into a status and error body. */
export async function runRelayJob(data: RelayJobData, deps: RelayDeps): Promise<RelayJobResult> {
  try {
    const result = await handleSubmit({ buildId: data.buildId, signedEnvelope: data.signedEnvelope }, { ip: data.ip, ...(data.apiKey ? { apiKey: data.apiKey } : {}) }, deps);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof CapstanError) return { ok: false, status: e.status, body: e.toBody() };
    deps.log?.("relay job failed", { buildId: data.buildId, error: (e as Error).message });
    return { ok: false, status: 500, body: errorBody("INTERNAL_ERROR") };
  }
}

export function startRelayWorker(connection: Redis, deps: RelayDeps, o: { concurrency?: number; prefix?: string } = {}): Worker<RelayJobData, RelayJobResult> {
  return new Worker<RelayJobData, RelayJobResult>(QUEUES.relaySubmit, async (job: Job<RelayJobData>) => traceFromJob(job.data, "relay submit", () => runRelayJob(job.data, deps)), { connection, prefix: o.prefix ?? "capstan", concurrency: o.concurrency ?? 8 });
}

export interface RelayClient {
  submit(data: RelayJobData, priority: Priority, jobId: string): Promise<RelayJobResult | { queued: true }>;
  close(): Promise<void>;
}

/** The api side: enqueue and wait up to `waitMs` (default 10 s). */
export function relayQueueClient(connection: Redis, o: { waitMs?: number; prefix?: string } = {}): RelayClient {
  const prefix = o.prefix ?? "capstan";
  const q = new Queue<RelayJobData, RelayJobResult>(QUEUES.relaySubmit, { connection, prefix });
  const events = new QueueEvents(QUEUES.relaySubmit, { connection: connection.duplicate(), prefix });
  const ready = events.waitUntilReady();
  return {
    async submit(data, priority, jobId) {
      await ready;
      const job = await q.add("relay-submit", traceJobData(data), { jobId, priority: BULL_PRIORITY[priority], removeOnComplete: { age: 3600 }, removeOnFail: { age: 86_400 }, attempts: 1 });
      try {
        return (await job.waitUntilFinished(events, o.waitMs ?? 10_000)) as RelayJobResult;
      } catch {
        return { queued: true };
      }
    },
    async close() {
      await events.close();
      await q.close();
    },
  };
}

/** In-process client (tests and single-process local runs): the same pipeline without a queue. */
export function inProcessRelayClient(deps: RelayDeps): RelayClient {
  return {
    submit: (data) => runRelayJob(data, deps),
    async close() {},
  };
}
