// Daily IP retention (02:15 UTC): log files under LOG_DIR (default /var/log/capstan, service and Caddy logs) and the
// request_logs table keep only the country code for anything older than 7 days (spec 14). Idempotent.
import type { JobDef, JobDeps } from "@capstan/core";
import { retainLogs, retainTables, type CountryLookup } from "@capstan/telemetry";

export const DEFAULT_LOG_DIR = "/var/log/capstan";

export async function runLogRetention(deps: JobDeps, o: { dir?: string; country?: CountryLookup } = {}) {
  const now = deps.now();
  const dir = o.dir ?? process.env.LOG_DIR ?? DEFAULT_LOG_DIR;
  const logs = retainLogs({ dir, now, country: o.country });
  const tables = deps.db ? await retainTables(deps.db, now, undefined, o.country) : { requestLogs: 0 };
  deps.log.info("ip retention done", { dir, ...logs, requestLogsStripped: tables.requestLogs });
  return { logs, tables };
}

export const job: JobDef = {
  name: "log-retention",
  queue: "reconcileDaily",
  schedule: { pattern: "15 2 * * *" },
  concurrency: 1,
  handler: (_job, deps) => runLogRetention(deps),
};
