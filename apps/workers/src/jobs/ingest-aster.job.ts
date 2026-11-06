// Aster market-data ingest, every 60 s: re-reads every market's funding interval (an interval change is picked up
// within one tick), keeps one WS stream open for marks, funding and the depth of routed (executable) symbols, and
// falls back to one REST funding read if the mark stream goes quiet. Public unsigned reads only.
import { createAsterIngest, defaultAsterReader, symbolOf, type AsterIngest } from "@capstan/adapter-aster";
import type { JobDef, JobDeps } from "@capstan/core";
import { db as schema } from "@capstan/schema";
import { and, eq } from "drizzle-orm";

let running: AsterIngest | null = null;

/** Executable Aster markets, as venue symbols. Without a database nothing is routed (marks still stream). */
export async function routedAsterSymbols(deps: Pick<JobDeps, "db">): Promise<string[]> {
  if (!deps.db) return [];
  const rows = await deps.db
    .select({ id: schema.markets.id })
    .from(schema.markets)
    .where(and(eq(schema.markets.venue, "aster"), eq(schema.markets.executable, true), eq(schema.markets.status, "active")));
  return rows.map((r) => symbolOf(r.id));
}

export function ingestFor(deps: JobDeps): AsterIngest {
  if (running) return running;
  if (!deps.cache) throw new Error("ingest-aster needs the market data cache");
  const cache = deps.cache;
  running = createAsterIngest({
    reader: defaultAsterReader({ redis: deps.redis, cache }),
    cache,
    routedSymbols: () => routedAsterSymbols(deps),
  });
  return running;
}

/** Tests and shutdown. */
export function stopAsterIngest(): void {
  running?.stop();
  running = null;
}

export const job: JobDef = {
  name: "ingest-aster",
  queue: "fundingTick",
  schedule: { every: 60_000 },
  concurrency: 1,
  async handler(_job, deps) {
    const report = await ingestFor(deps).tick();
    if (report.intervalChanges.length) deps.log.info("aster funding interval changed", { changes: report.intervalChanges });
    return report;
  },
};
