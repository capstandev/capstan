// lock-snapshot (daily 00:30 UTC): reads CPSTLock lockedOf for every address that ever locked (Locked events, read in
// chunks) and every account owner, and writes lock_snapshots at the start of the UTC day (idempotent per day). The
// snapshots weight the advisory governance poll and the access-credit share. No CPSTLock deployed yet: nothing to do.
import type { JobDef, JobDeps } from "@capstan/core";
import { lockOwnersFromLogs, snapshotLocks, viemLockReader, type LockReader } from "@capstan/plans";
import { DEPLOYMENTS, type Hex } from "@capstan/schema";
import { createPublicClient, http, type PublicClient } from "viem";

export function dayStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export interface LockSnapshotSource {
  lock: LockReader;
  /** Owners seen in Locked events. */
  lockOwners(): Promise<Hex[]>;
}

export function sourceFromEnv(env: Record<string, string | undefined> = process.env): LockSnapshotSource | null {
  const chainId = env.CAPSTAN_NETWORK === "mainnet" ? 4663 : 46630;
  const dep = DEPLOYMENTS[chainId]?.contracts.CPSTLock;
  const rpc = chainId === 4663 ? env.RHC_RPC_URL : env.RHC_TESTNET_RPC_URL;
  if (!dep || !rpc) return null;
  const client = createPublicClient({ transport: http(rpc, { retryCount: 3 }) }) as PublicClient;
  return { lock: viemLockReader(client, dep.address), lockOwners: () => lockOwnersFromLogs(client, dep.address, BigInt(dep.block ?? 0)) };
}

export async function runLockSnapshot(deps: JobDeps, source: LockSnapshotSource | null = sourceFromEnv()): Promise<number> {
  if (!deps.db) throw new Error("lock-snapshot needs a database");
  if (!source) {
    deps.log.info("lock-snapshot: no CPSTLock deployment on this network yet");
    return 0;
  }
  const fromAccounts = (await deps.db.$client`select distinct lower(owner_wallet) as o from api_accounts where owner_wallet is not null`) as unknown as { o: string }[];
  const owners = [...(await source.lockOwners()), ...fromAccounts.map((r) => r.o as Hex)];
  const ts = dayStartUtc(deps.now());
  const n = await snapshotLocks(deps.db, source.lock, owners, ts);
  deps.log.info("lock-snapshot report", { ts: ts.toISOString(), owners: new Set(owners.map((o) => o.toLowerCase())).size, withLock: n });
  return n;
}

export const job: JobDef = {
  name: "lock-snapshot",
  queue: "reconcileDaily",
  schedule: { pattern: "30 0 * * *" },
  concurrency: 1,
  handler: (_job, deps) => runLockSnapshot(deps),
};
