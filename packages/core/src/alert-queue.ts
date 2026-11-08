// The producer side of the user alert queue (alerts-dispatch), shared by the api, the relay and the workers so every
// producer sets the same BullMQ priority (R1-8-03). BullMQ runs a job added with no priority before every prioritised
// job, so a producer that called queue.add directly would put caller-triggerable work ahead of liquidation alerts.
// Producers go through enqueueAlertJob (workers: enqueueAlertWork) or enqueuePolicyBreach; nothing else adds to the
// queue (apps/workers/test/alerts/isolation.test.ts scans the sources for a direct add).
import type { Hex, VenueId } from "@capstan/schema";

export const ALERT_JOB = "alerts-dispatch";

export type AlertSource = "risk" | "plan" | "policy_breach" | "expiry_scan";

/**
 * BullMQ priority per source (1 is taken first). Liquidation distance comes from risk-compute and cannot be triggered by
 * a caller, so it goes ahead of work any wallet can cause (its own plan ends, its own agent's refusals).
 */
export const ALERT_PRIORITY: Record<AlertSource, number> = { risk: 1, expiry_scan: 2, policy_breach: 3, plan: 3 };

export interface AlertQueueLike {
  add(name: string, data: unknown, opts?: { removeOnComplete?: number; removeOnFail?: number; jobId?: string; priority?: number }): Promise<unknown>;
}

/** Add one unit of alert work with its source's priority. Every producer of the alert queue calls this. */
export async function enqueueAlertJob(q: AlertQueueLike, w: { source: AlertSource }): Promise<void> {
  const priority = ALERT_PRIORITY[w.source];
  if (priority === undefined) throw new Error(`alert work with unknown source ${String(w.source)}`);
  await q.add(ALERT_JOB, w, { removeOnComplete: 1000, removeOnFail: 5000, priority });
}

/** A POLICY_BREACH refusal (api order build, relay submit): caller-triggerable, so it waits behind liquidation alerts. */
export function enqueuePolicyBreach(q: AlertQueueLike, x: { owner: Hex; agentRef: string; field: string; venue?: VenueId }): Promise<void> {
  return enqueueAlertJob(q, { source: "policy_breach", owner: x.owner.toLowerCase() as Hex, agentRef: x.agentRef, field: x.field, ...(x.venue ? { venue: x.venue } : {}) } as { source: AlertSource });
}
