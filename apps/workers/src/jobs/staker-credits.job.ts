// staker-credits (monthly, the 1st at 01:00 UTC): the access-credit share for lockers, paid in kind as premium-call
// credits pro rata to the latest lock snapshot. Switched OFF by default: it runs only with STAKER_BUCKET_ENABLED=1
// (pending review). When off it logs one line and writes nothing.
import type { JobDef, JobDeps } from "@capstan/core";
import { grantCredit, snapshotAt, stakerCredits } from "@capstan/plans";

export const OFF_MESSAGE = "access-credit share off (pending review)";

export interface StakerRun {
  enabled: boolean;
  snapshotTs: string | null;
  credited: number;
  skippedNoAccount: number;
}

export async function runStakerCredits(deps: JobDeps, env: Record<string, string | undefined> = process.env): Promise<StakerRun> {
  if (env.STAKER_BUCKET_ENABLED !== "1") {
    deps.log.info(OFF_MESSAGE);
    return { enabled: false, snapshotTs: null, credited: 0, skippedNoAccount: 0 };
  }
  if (!deps.db) throw new Error("staker-credits needs a database");
  const bucket = env.STAKER_BUCKET_USD ?? "";
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(bucket) || !(Number(bucket) > 0)) throw new Error("STAKER_BUCKET_USD must be a positive USD amount");
  const latest = (await deps.db.$client`select max(ts) as ts from lock_snapshots`) as unknown as { ts: Date | null }[];
  const ts = latest[0]?.ts ? new Date(latest[0].ts) : null;
  if (!ts) {
    deps.log.info("staker-credits: no lock snapshot yet");
    return { enabled: true, snapshotTs: null, credited: 0, skippedNoAccount: 0 };
  }
  const shares = stakerCredits(await snapshotAt(deps.db, ts), bucket);
  let credited = 0;
  let skipped = 0;
  for (const s of shares) {
    if (s.credits === "0") continue;
    const acct = (await deps.db.$client`select id from api_accounts where lower(owner_wallet) = ${s.owner.toLowerCase()} order by id limit 1`) as unknown as { id: string }[];
    if (!acct[0]) {
      skipped++;
      continue;
    }
    if (await grantCredit(deps.db, acct[0].id, s.credits, "access_credit", `access:${ts.toISOString()}`)) credited++;
  }
  deps.log.info("staker-credits report", { snapshotTs: ts.toISOString(), credited, skippedNoAccount: skipped });
  return { enabled: true, snapshotTs: ts.toISOString(), credited, skippedNoAccount: skipped };
}

export const job: JobDef = {
  name: "staker-credits",
  queue: "reconcileDaily",
  schedule: { pattern: "0 1 1 * *" },
  concurrency: 1,
  handler: (_job, deps) => runStakerCredits(deps),
};
