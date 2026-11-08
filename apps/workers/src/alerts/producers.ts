// Producers put alert work on the alerts-dispatch queue; the job turns it into user alerts with the rules.
// risk-compute (19) sends each owner's ladder, the spread events route (21) sends unhedged plan ends, and the relay
// (30) sends POLICY_BREACH refusals with enqueuePolicyBreach. A daily scheduled run scans approval expiry.
import { ALERT_JOB, ALERT_PRIORITY, enqueueAlertJob, enqueuePolicyBreach, type AlertQueueLike } from "@capstan/core";
import type { Hex, VenueId } from "@capstan/schema";
import type { LadderRow } from "@capstan/risk";

export type AlertWork =
  | { source: "risk"; owner: Hex; ladder: Pick<LadderRow, "marketId" | "venue" | "distancePct" | "liqPx" | "markPx">[] }
  | { source: "plan"; owner: Hex; planId: string; kind: string; data: { residualDeltaBase?: string; reason?: string } }
  | { source: "policy_breach"; owner: Hex; agentRef: string; field: string; venue?: VenueId }
  | { source: "expiry_scan" };

/** The queue the producers add to (the same shape as @capstan/core AlertQueueLike). */
export type QueueLike = AlertQueueLike;

export { ALERT_JOB, ALERT_PRIORITY, enqueuePolicyBreach };

/** Add alert work with its source's BullMQ priority (R1-8-03; every producer goes through enqueueAlertJob). */
export async function enqueueAlertWork(q: QueueLike, w: AlertWork): Promise<void> {
  await enqueueAlertJob(q, w);
}
