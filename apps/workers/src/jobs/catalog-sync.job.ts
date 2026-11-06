// Nightly catalog sync (00:15 UTC): loads every catalog-sources/*.source.ts (sorted glob), runs syncMarkets, writes
// one report log line, and raises an ops alert for new dexes, markets turned reduce-only and source errors.
// Alerts go to deps.publish on the 'ops.alert' channel when present (the alerts work routes them); else they are logged.
import { syncMarkets, type MarketSource, type SyncReport } from "@capstan/catalog";
import type { JobDef, JobDeps } from "@capstan/core";
import { join } from "node:path";

export const SOURCES_DIR = join(import.meta.dir, "catalog-sources");
export const OPS_ALERT_CHANNEL = "ops.alert";

export async function loadSources(dir = SOURCES_DIR): Promise<MarketSource[]> {
  const files: string[] = [];
  for await (const f of new Bun.Glob("*.source.ts").scan({ cwd: dir, onlyFiles: true })) files.push(f);
  files.sort();
  const out: MarketSource[] = [];
  for (const f of files) {
    const mod = (await import(join(dir, f))) as { source?: MarketSource };
    if (!mod.source || typeof mod.source.listMarkets !== "function" || !mod.source.venue) throw new Error(`${f}: must export source: MarketSource`);
    out.push(mod.source);
  }
  return out;
}

export async function runCatalogSync(deps: JobDeps, sources?: MarketSource[]): Promise<SyncReport> {
  if (!deps.db) throw new Error("catalog-sync needs a database");
  const report = await syncMarkets(deps.db, sources ?? (await loadSources()), deps.now());
  deps.log.info("catalog-sync report", {
    added: report.added.length,
    updated: report.updated.length,
    delisted: report.delisted,
    reduceOnly: report.reduceOnly,
    newDexes: report.newDexes,
    aliasProposals: report.aliasProposals.length,
    errors: report.errors,
  });
  const alerts: { kind: string; detail: unknown }[] = [];
  if (report.newDexes.length) alerts.push({ kind: "catalog.new_dexes", detail: report.newDexes });
  if (report.reduceOnly.length) alerts.push({ kind: "catalog.reduce_only", detail: report.reduceOnly });
  if (report.errors.length) alerts.push({ kind: "catalog.source_errors", detail: report.errors });
  for (const a of alerts) {
    if (deps.publish) await deps.publish(OPS_ALERT_CHANNEL, a);
    else deps.log.warn("ops alert", a);
  }
  return report;
}

export const job: JobDef = {
  name: "catalog-sync",
  queue: "catalogSync",
  schedule: { pattern: "15 0 * * *" },
  concurrency: 1,
  handler: (_job, deps) => runCatalogSync(deps),
};
