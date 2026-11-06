// tierOf: account plan (api_accounts.tier) plus the live CPSTLock amount of the owner wallet.
// - A lock tier (holder or whale) sets the multiplier and the 1 bp builder fee; a Pro account keeps tier "pro" and
//   gets the lock multiplier and fee on top.
// - Lock reads are cached for cacheTtlMs (60 s). On an RPC failure the last good value is used for at most 10 minutes;
//   after that the owner is treated as having nothing locked (fail to the lower tier).
// - Sybil rule: a new wallet (first seen under 24 h ago, no venue activity) gets half the free build and relay rate.
import { schema, type Db } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { eq } from "drizzle-orm";
import { parseAbi, type PublicClient } from "viem";
import { LOCK_FEE, limitsFor, lockTierOf, multiplierOf, NEW_WALLET_AGE_MS, STANDARD_FEE, type BuilderFee, type Limits, type Tier } from "./tiers";

export interface LockReader {
  lockedOf(owner: Hex): Promise<{ amount: bigint; unlockAt: bigint }>;
}

export const LOCK_ABI = parseAbi([
  "function lockedOf(address account) view returns (uint256 amount, uint64 unlockAt)",
  "event Locked(address indexed account, uint256 amount, uint64 unlockAt)",
]);

/** LockReader over viem readContract on the CPSTLock address from the deployment file. */
export function viemLockReader(client: Pick<PublicClient, "readContract">, lock: Hex): LockReader {
  return {
    async lockedOf(owner) {
      const [amount, unlockAt] = (await client.readContract({ address: lock, abi: LOCK_ABI, functionName: "lockedOf", args: [owner] })) as readonly [bigint, bigint];
      return { amount, unlockAt: BigInt(unlockAt) };
    },
  };
}

export interface WalletActivity {
  /** When Capstan first saw this wallet (onboarding, delegation or order), or null if never. */
  firstSeen(owner: Hex): Promise<Date | null>;
  /** Whether the wallet has any venue activity (an active delegation or an order). */
  hasVenueActivity(owner: Hex): Promise<boolean>;
}

/** WalletActivity from Capstan's own tables (no paid indexer). */
export function dbWalletActivity(db: Db): WalletActivity {
  return {
    async firstSeen(owner) {
      const o = owner.toLowerCase();
      const rows = (await db.$client`
        select min(t) as first from (
          select min(created_at) as t from onboarding_sessions where lower(owner) = ${o}
          union all select min(created_at) from delegations where lower(owner) = ${o}
          union all select min(submitted_at) from orders where lower(owner) = ${o}
        ) s`) as unknown as { first: Date | null }[];
      return rows[0]?.first ? new Date(rows[0].first) : null;
    },
    async hasVenueActivity(owner) {
      const o = owner.toLowerCase();
      const rows = (await db.$client`
        select 1 from delegations where lower(owner) = ${o} and state = 'active'
        union all select 1 from orders where lower(owner) = ${o} limit 1`) as unknown as unknown[];
      return rows.length > 0;
    },
  };
}

export const LOCK_CACHE_MAX_STALE_MS = 10 * 60 * 1000;

export interface TierDeps {
  db: Db | null;
  lock: LockReader;
  cacheTtlMs: number;
  activity?: WalletActivity;
  now?: () => number;
}

export interface TierResult {
  tier: Tier;
  builderFee: BuilderFee;
  multiplier: 1 | 2 | 5;
  limits: Limits;
  newWallet: boolean;
  locked: bigint;
}

type Entry = { amount: bigint; at: number };
const caches = new WeakMap<LockReader, Map<string, Entry>>();

async function lockedAmount(lock: LockReader, owner: Hex, ttl: number, now: number): Promise<bigint> {
  let cache = caches.get(lock);
  if (!cache) caches.set(lock, (cache = new Map()));
  const key = owner.toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttl) return hit.amount;
  try {
    const r = await lock.lockedOf(owner);
    cache.set(key, { amount: r.amount, at: now });
    return r.amount;
  } catch {
    if (hit && now - hit.at <= LOCK_CACHE_MAX_STALE_MS) return hit.amount;
    return 0n; // no good value in the last 10 minutes: the lower tier
  }
}

const PLAN_TIERS = new Set<Tier>(["free", "payg", "pro"]);

export async function tierOf(subject: { apiKeyId?: string; owner?: Hex }, deps: TierDeps): Promise<TierResult> {
  const now = (deps.now ?? Date.now)();
  let plan: Tier = "free";
  let owner = subject.owner;
  if (subject.apiKeyId && deps.db) {
    const rows = await deps.db.select().from(schema.apiAccounts).where(eq(schema.apiAccounts.id, subject.apiKeyId));
    const row = rows[0];
    if (row) {
      if (PLAN_TIERS.has(row.tier as Tier)) plan = row.tier as Tier;
      if (!owner && row.ownerWallet) owner = row.ownerWallet as Hex;
    }
  }
  const locked = owner ? await lockedAmount(deps.lock, owner, deps.cacheTtlMs, now) : 0n;
  const lockTier = lockTierOf(locked);
  const tier: Tier = plan === "pro" ? "pro" : (lockTier ?? plan);
  let newWallet = false;
  if (owner && deps.activity && !lockTier && plan !== "pro") {
    try {
      const first = await deps.activity.firstSeen(owner);
      const young = first === null || now - first.getTime() < NEW_WALLET_AGE_MS;
      newWallet = young && !(await deps.activity.hasVenueActivity(owner));
    } catch {
      newWallet = true; // unknown history: the stricter build and relay rate
    }
  }
  return {
    tier,
    builderFee: lockTier ? LOCK_FEE : STANDARD_FEE,
    multiplier: multiplierOf(lockTier),
    limits: limitsFor(tier, { newWallet }),
    newWallet,
    locked,
  };
}
