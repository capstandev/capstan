// CPSTLock snapshots (lock_snapshots): the weights for the advisory governance poll and for the staker access-credit
// share. The share is in-kind premium-call credits only, pro rata to locked amounts, and it ships switched off.
import { schema, type Db } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { eq } from "drizzle-orm";
import type { PublicClient } from "viem";
import { LOCK_ABI, type LockReader } from "./tier-of";

export interface LockSnapshot {
  ts: Date;
  owner: Hex;
  amount: bigint;
}

/** Read lockedOf for every owner and write one row per owner with a lock at `ts`. Returns rows written. Idempotent. */
export async function snapshotLocks(db: Db, lock: LockReader, owners: Hex[], ts: Date): Promise<number> {
  const unique = [...new Set(owners.map((o) => o.toLowerCase() as Hex))].sort();
  const rows: { ts: Date; owner: string; amount: string }[] = [];
  for (const owner of unique) {
    const { amount } = await lock.lockedOf(owner); // an RPC error aborts the whole snapshot (no partial poll weights)
    if (amount > 0n) rows.push({ ts, owner, amount: amount.toString() });
  }
  if (rows.length) await db.insert(schema.lockSnapshots).values(rows).onConflictDoNothing();
  return rows.length;
}

export async function snapshotAt(db: Db, ts: Date): Promise<LockSnapshot[]> {
  const r = await db.select().from(schema.lockSnapshots).where(eq(schema.lockSnapshots.ts, ts));
  return r.map((x) => ({ ts: x.ts, owner: x.owner as Hex, amount: BigInt(x.amount) })).sort((a, b) => (a.owner < b.owner ? -1 : 1));
}

/** Every address that ever locked, from Locked events, read in chunks (public RPCs cap getLogs ranges). */
export async function lockOwnersFromLogs(client: Pick<PublicClient, "getLogs" | "getBlockNumber">, lock: Hex, fromBlock: bigint, chunk = 10_000n): Promise<Hex[]> {
  const to = await client.getBlockNumber();
  const out = new Set<Hex>();
  for (let start = fromBlock; start <= to; start += chunk) {
    const end = start + chunk - 1n > to ? to : start + chunk - 1n;
    const logs = await client.getLogs({ address: lock, event: LOCK_ABI[1], fromBlock: start, toBlock: end });
    for (const l of logs) if (l.args.account) out.add(l.args.account.toLowerCase() as Hex);
  }
  return [...out].sort();
}

/**
 * Pro-rata access credits from one snapshot. Exact in micro-USD: each owner gets floor(share) and the remainder goes
 * to the largest fractional parts (ties by owner address), so the credits always sum to the bucket.
 */
export function stakerCredits(snapshots: LockSnapshot[], bucketUsd: string): { owner: Hex; credits: string }[] {
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(bucketUsd)) throw new Error("bucket must be a USD amount with at most 6 decimals");
  const [w, f = ""] = bucketUsd.split(".");
  const bucket = BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0") || "0");
  const live = snapshots.filter((s) => s.amount > 0n);
  const total = live.reduce((s, x) => s + x.amount, 0n);
  if (total === 0n || bucket === 0n) return live.map((s) => ({ owner: s.owner, credits: "0" }));
  const parts = live.map((s) => {
    const num = bucket * s.amount;
    return { owner: s.owner, base: num / total, rem: num % total };
  });
  let left = bucket - parts.reduce((s, p) => s + p.base, 0n);
  const order = [...parts].sort((a, b) => (a.rem === b.rem ? (a.owner < b.owner ? -1 : 1) : a.rem > b.rem ? -1 : 1));
  for (const p of order) {
    if (left === 0n) break;
    p.base += 1n;
    left -= 1n;
  }
  const fmt = (micro: bigint) => {
    const s = micro.toString().padStart(7, "0");
    const frac = s.slice(-6).replace(/0+$/, "");
    return frac ? `${s.slice(0, -6)}.${frac}` : s.slice(0, -6);
  };
  return parts.map((p) => ({ owner: p.owner, credits: fmt(p.base) }));
}

/** CSV for the advisory poll: owner,amount (wei) at one snapshot time, sorted by owner. */
export function pollCsv(snapshots: LockSnapshot[]): string {
  const lines = ["owner,amount"];
  for (const s of [...snapshots].sort((a, b) => (a.owner < b.owner ? -1 : 1))) lines.push(`${s.owner.toLowerCase()},${s.amount.toString()}`);
  return `${lines.join("\n")}\n`;
}
