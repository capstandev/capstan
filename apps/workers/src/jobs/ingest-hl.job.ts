// Hyperliquid ingest (spec 9 `ingest-hl`): the first run opens the shared WebSocket pool (books and mids into the
// market-data cache); every run, once a minute, polls marks and funding per dex into mark_ticks / funding_ticks and
// snapshots the top 20 book levels into book_snapshots. Reads only; no user channels.
import type { JobDef, JobDeps } from "@capstan/core";
import { sharedHlIngest } from "@capstan/adapter-hyperliquid";

export async function runIngestHl(deps: JobDeps, env: Record<string, string | undefined> = process.env) {
  const ingest = await sharedHlIngest(env, { redis: deps.redis, cache: deps.cache, db: deps.db, log: deps.log });
  const report = await ingest.pollOnce();
  deps.log.info("ingest-hl poll", { marks: report.marks, funding: report.funding, snapshots: report.snapshots, errors: report.errors.length });
  return report;
}

export const job: JobDef = {
  name: "ingest-hl",
  queue: "fundingTick",
  schedule: { every: 60_000 },
  concurrency: 1,
  handler: (_job, deps) => runIngestHl(deps),
};
