// root-indexer: every 5 minutes, chunked getLogs (2,000 blocks, backoff on 429) for RootPosted from the deployment
// block; writes root_events and compares each with receipt_roots (a difference raises a critical ops alert).
import type { JobDef, JobDeps } from "@capstan/core";
import { buildAnchorContext, indexRoots, type AnchorContext } from "../anchor";

let ctx: Promise<AnchorContext> | null = null;
const context = (deps: JobDeps): Promise<AnchorContext> => (ctx ??= buildAnchorContext(deps).catch((e) => ((ctx = null), Promise.reject(e))));

export const job: JobDef = {
  name: "root-indexer",
  queue: "anchorHourly",
  schedule: { every: 5 * 60 * 1000 },
  concurrency: 1,
  async handler(_job, deps) {
    const c = await context(deps);
    return indexRoots(c.deploymentBlock, { rpc: c.rpc, db: c.db, anchor: c.anchor, maxRange: 2000, publish: deps.publish, log: deps.log });
  },
};
