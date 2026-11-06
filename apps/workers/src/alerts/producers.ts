// Producers put alert work on the alerts-dispatch queue; the job turns it into user alerts with the rules.
// risk-compute (19) sends each owner's ladder, the spread events route (21) sends unhedged plan ends, and the relay
// (30) sends POLICY_BREACH refusals with enqueuePolicyBreach. A daily scheduled run scans approval expiry.
import type { Hex, VenueId } from "@capstan/schema";
import type { LadderRow } from "@capstan/risk";

export type AlertWork =
  | { source: "risk"; owner: Hex; ladder: Pick<LadderRow, "marketId" | "venue" | "distancePct" | "liqPx" | "markPx">[] }
  | { source: "plan"; owner: Hex; planId: string; kind: string; data: { residualDeltaBase?: string; reason?: string } }
  | { source: "policy_breach"; owner: Hex; agentRef: string; field: string; venue?: VenueId }
  | { source: "expiry_scan" };

export interface QueueLike {
  add(name: string, data: unknown, opts?: { removeOnComplete?: number; removeOnFail?: number; jobId?: string }): Promise<unknown>;
}

export const ALERT_JOB = "alerts-dispatch";

export async function enqueueAlertWork(q: QueueLike, w: AlertWork): Promise<void> {
  await q.add(ALERT_JOB, w, { removeOnComplete: 1000, removeOnFail: 5000 });
}

export const enqueuePolicyBreach = (q: QueueLike, x: { owner: Hex; agentRef: string; field: string; venue?: VenueId }) => enqueueAlertWork(q, { source: "policy_breach", ...x });
