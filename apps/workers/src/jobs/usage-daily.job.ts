// Daily usage (03:00 UTC, after the reconciler): computes yesterday's UsageDay and replaces its usage_daily rows
// (idempotent per day). Approvals come from venue reads: Hyperliquid maxBuilderFee for HL_BUILDER_ADDRESS (public);
// Aster approvedUserList is a signed builder read on the VPS only.
import type { JobDef, JobDeps } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { addDays, computeDay, hlInfoReader, writeDay, type ComputeDeps } from "@capstan/ops-usage";

export async function runUsageDaily(deps: JobDeps, o: Partial<Omit<ComputeDeps, "db">> & { day?: string } = {}) {
  if (!deps.db) throw new Error("usage-daily: needs the database");
  const day = o.day ?? addDays(deps.now().toISOString().slice(0, 10), -1);
  const builder = o.builder ?? (process.env.HL_BUILDER_ADDRESS as Hex | undefined) ?? undefined;
  // TODO(owner): pass the Aster approvedUserList reader from the VPS wiring (BACKLOG A4, E2); without it the Aster
  // count is reported as "not read", never guessed.
  const u = await computeDay(day, { db: deps.db, hl: o.hl ?? (builder ? hlInfoReader() : undefined), builder, asterApproved: o.asterApproved, visitors: o.visitors });
  const rows = await writeDay(deps.db, u);
  deps.log.info("usage day written", { day, rows, approvals: u.approvals.union, flagged: u.approvalsFlagged ?? 0 });
  return u;
}

export const job: JobDef = {
  name: "usage-daily",
  queue: "reconcileDaily",
  schedule: { pattern: "0 3 * * *" },
  concurrency: 1,
  handler: (_job, deps) => runUsageDaily(deps),
};
