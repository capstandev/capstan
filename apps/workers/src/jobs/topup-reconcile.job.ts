// topup-reconcile (every minute): credits a prepaid top-up whose settle came back settlement_pending once the
// facilitator's reconciler has seen its tx mined (security review r1 review-r1:4 F4). Exactly once per payment
// (the same settlement id as the after-settle hook); a failed or dropped payment and a top-up still pending after
// 10 minutes raise an ops alert.
import type { JobDef, JobDeps } from "@capstan/core";
import { reconcilePendingTopups, type PendingTopupRun } from "@capstan/plans";

export const OPS_ALERT_CHANNEL = "ops.alert";
export const TOPUP_RECONCILE_EVERY_MS = 60_000;
const alerted = new Set<string>();

export async function runTopupReconcile(deps: JobDeps): Promise<PendingTopupRun> {
  if (!deps.db) throw new Error("topup-reconcile needs a database");
  const run = await reconcilePendingTopups(deps.db, {
    now: () => deps.now().getTime(),
    alerted,
    alert: async (a) => {
      if (deps.publish) await deps.publish(OPS_ALERT_CHANNEL, a);
      else deps.log.warn("ops alert", a);
    },
  });
  if (run.checked) deps.log.info("topup-reconcile report", { ...run });
  return run;
}

export const job: JobDef = {
  name: "topup-reconcile",
  queue: "x402Settle",
  schedule: { every: TOPUP_RECONCILE_EVERY_MS },
  concurrency: 1,
  handler: (_job, deps) => runTopupReconcile(deps),
};
