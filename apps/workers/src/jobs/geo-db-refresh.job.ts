// Weekly DB-IP Lite country refresh (Mondays 03:30 UTC). DB-IP publishes monthly; the weekly run picks up the new
// month's file once it exists, logs its sha256 and swaps it in atomically (CAPSTAN_GEO_DIR, default var/geo).
// A failed refresh keeps the previous file and raises an ops event.
import type { JobDef, JobDeps } from "@capstan/core";
import { refreshGeoDb, type RefreshOptions, type RefreshResult } from "@capstan/eligibility";

export const OPS_ALERT_CHANNEL = "ops.alert";

export async function runGeoRefresh(deps: JobDeps, o: Partial<RefreshOptions> = {}): Promise<RefreshResult> {
  const dir = o.dir ?? process.env.CAPSTAN_GEO_DIR ?? "var/geo";
  const r = await refreshGeoDb({ dir, now: deps.now, ...o });
  if (r.status === "failed") {
    const event = { kind: "geo.refresh_failed", severity: "warn", detail: { reason: r.reason ?? "unknown", month: r.month } };
    if (deps.publish) await deps.publish(OPS_ALERT_CHANNEL, event);
    deps.log.warn("geo refresh failed", event.detail);
  } else {
    deps.log.info("geo refresh", { status: r.status, month: r.month, sha256: r.sha256 });
  }
  return r;
}

export const job: JobDef = {
  name: "geo-db-refresh",
  queue: "catalogSync",
  schedule: { pattern: "30 3 * * 1" },
  concurrency: 1,
  handler: (_job, deps) => runGeoRefresh(deps),
};
