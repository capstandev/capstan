// merkle-anchor (spec 9, 11): Job Scheduler at :05 every hour UTC, one instance. Posts the root of every non-empty
// hour since the last recorded one, in order, at most 24 per run (KEEP-3), checking rootOf on chain before each post.
import type { JobDef, JobDeps } from "@capstan/core";
import { anchorBacklog, buildAnchorContext, type AnchorContext } from "../anchor";

let ctx: Promise<AnchorContext> | null = null;
const context = (deps: JobDeps): Promise<AnchorContext> => (ctx ??= buildAnchorContext(deps).catch((e) => ((ctx = null), Promise.reject(e))));

export const job: JobDef = {
  name: "merkle-anchor",
  queue: "anchorHourly",
  schedule: { pattern: "5 * * * *" },
  concurrency: 1,
  async handler(_job, deps) {
    const c = await context(deps);
    const results = await anchorBacklog({ ...c, now: deps.now, log: deps.log, publish: deps.publish });
    deps.log.info("merkle-anchor run", { hours: results.length, posted: results.filter((r) => r.status === "posted").length });
    return results;
  },
};
