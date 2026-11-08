// alerts-dispatch (spec 9 alerts): consumes alert work from risk-compute (liquidation distance), the spread events
// route (unhedged plans) and the relay (POLICY_BREACH refusals), plus a daily approval-expiry scan, and delivers user
// alerts to the owners' webhooks. Never to the ops channel; never a key or a signed user payload in a webhook.
import { schema, type Db, type JobDef } from "@capstan/core";
import type { CapstanRiskView } from "@capstan/risk";
import { and, eq, isNotNull } from "drizzle-orm";
import { DelayedError, type Job } from "bullmq";
import { readFileSync } from "node:fs";
import { dispatch, expiryAlerts, JOB_BUDGET_MS, liqAlerts, policyBreachAlert, secretDeriver, unhedgedAlert, type AlertEvent, type AlertWork, type DispatchDeps } from "../alerts";
import { OWNER_BUSY_DELAY_MS, redisOwnerLock, redisSlowStreak, type OwnerLock } from "../alerts/owner-limits";

export function alertsFor(w: AlertWork, delegations: (typeof schema.delegations.$inferSelect)[], now: Date): AlertEvent[] {
  switch (w.source) {
    case "risk":
      return liqAlerts(w.owner, { liquidationLadder: w.ladder as CapstanRiskView["liquidationLadder"] });
    case "plan": {
      const a = unhedgedAlert(w);
      return a ? [a] : [];
    }
    case "policy_breach":
      return [policyBreachAlert(w)];
    case "expiry_scan":
      return expiryAlerts(delegations, now);
  }
}

export async function runAlertsDispatch(w: AlertWork, d: Omit<DispatchDeps, "db"> & { db: Db }): Promise<{ alerts: number; delivered: number }> {
  const now = d.now();
  const dels = w.source === "expiry_scan" ? await d.db.select().from(schema.delegations).where(and(eq(schema.delegations.state, "active"), isNotNull(schema.delegations.expiresAt))) : [];
  const alerts = alertsFor(w, dels, now);
  let delivered = 0;
  for (const a of alerts) delivered += await dispatch(a, d);
  return { alerts: alerts.length, delivered };
}

/** The server alert key (32+ bytes in a 0600 file on the api and workers hosts); without it nothing is delivered. */
export function alertKeyFromEnv(env: Record<string, string | undefined> = process.env): Uint8Array {
  const f = env.ALERTS_WEBHOOK_KEY_FILE;
  if (!f) throw new Error("alerts-dispatch: ALERTS_WEBHOOK_KEY_FILE is not set; user webhooks stay off");
  const k = readFileSync(f);
  if (k.length < 32) throw new Error("alerts-dispatch: the alert key file holds fewer than 32 bytes");
  return k;
}

/** Sources a wallet can cause itself: one of them runs at a time per owner (R1-8-03); risk and expiry work never wait. */
export const OWNER_SERIAL_SOURCES: readonly AlertWork["source"][] = ["plan", "policy_breach"];

/**
 * Run an owner's caller-triggerable alert only while no other one of the same owner runs, so one wallet holds at most
 * one worker slot. When the owner is busy the job goes back as delayed (same priority) and the slot is freed at once.
 */
export async function oneAtATimePerOwner<T>(j: Pick<Job, "moveToDelayed">, w: AlertWork, lock: OwnerLock, token: string | undefined, run: () => Promise<T>, now = Date.now): Promise<T> {
  if (!OWNER_SERIAL_SOURCES.includes(w.source) || !("owner" in w)) return run();
  const held = await lock.take(w.owner, JOB_BUDGET_MS + 5000);
  if (!held) {
    await j.moveToDelayed(now() + OWNER_BUSY_DELAY_MS, token);
    throw new DelayedError();
  }
  try {
    return await run();
  } finally {
    await held.release();
  }
}

export const job: JobDef = {
  name: "alerts-dispatch",
  queue: "alertsDispatch",
  schedule: { pattern: "30 2 * * *" }, // the daily approval-expiry scan; other work arrives as queued jobs
  concurrency: 2,
  async handler(j, deps) {
    if (!deps.db) throw new Error("alerts-dispatch needs a database");
    const raw = j.data as Partial<AlertWork> | undefined;
    const w: AlertWork = raw && typeof raw === "object" && "source" in raw && raw.source ? (raw as AlertWork) : { source: "expiry_scan" };
    const run = async () => {
      const r = await runAlertsDispatch(w, { db: deps.db!, now: deps.now, secretOf: secretDeriver(alertKeyFromEnv()), ...(deps.redis ? { slow: redisSlowStreak(deps.redis) } : {}) });
      deps.log.info("alerts-dispatch", { source: w.source, ...r });
      return r;
    };
    return deps.redis ? oneAtATimePerOwner(j, w, redisOwnerLock(deps.redis), deps.token, run) : run();
  },
};
