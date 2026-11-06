// Account reader (spec 9 account-reader). Hyperliquid and Lighter accounts are public and read keyless through the
// venue adapters (whose HTTP goes through the governor at 'free' priority: HL clearinghouseState costs 2 weight per
// dex). Each answer is cached 5 s. Aster accounts are never read with a server key: they come only from the client's
// signed reads ingested by POST /v1/risk/ingest; without one the venue shows status 'needs_signed_read'.
// Queries always use the main wallet (HL master address), never an agent address.
import type { AccountSnapshot, Hex, VenueAdapter, VenueId, VenueIdentity } from "@capstan/schema";

export const ACCOUNT_TTL_MS = 5000;

export type PendingStatus = "needs_signed_read" | "unavailable" | "excluded";

/** A venue identity the view could not read, with the reason in plain words. Never a guessed number. */
export interface PendingAccount {
  venue: VenueId;
  identity: VenueIdentity;
  status: PendingStatus;
  reason: string;
}

export interface KvCache {
  get(key: string): Promise<string | null>;
  /** Store with an expiry in milliseconds. */
  put(key: string, value: string, ttlMs: number): Promise<void>;
}

/** KvCache over ioredis (SET ... PX). */
export function redisKv(redis: { get(k: string): Promise<string | null>; set(k: string, v: string, mode: "PX", ms: number): Promise<unknown> }): KvCache {
  return {
    get: (k) => redis.get(k),
    async put(k, v, ttl) {
      await redis.set(k, v, "PX", ttl);
    },
  };
}

export function memoryKv(now: () => number = Date.now): KvCache {
  const m = new Map<string, { v: string; until: number }>();
  return {
    async get(k) {
      const e = m.get(k);
      if (!e || e.until <= now()) return null;
      return e.v;
    },
    async put(k, v, ttl) {
      m.set(k, { v, until: now() + ttl });
    },
  };
}

export type AccountAdapter = Pick<VenueAdapter, "caps" | "getAccount">;

export interface ReadAccountsDeps {
  adapters: Map<VenueId, AccountAdapter>;
  /** Latest ingested Aster snapshot for the owner (signed by the owner's own agent key), or null. */
  asterIngested: (owner: Hex) => Promise<AccountSnapshot | null>;
  cache: KvCache;
  ttlMs?: number;
  /** Called once per snapshot read from the venue (not from cache): the risk-refresh job publishes it. */
  onRefreshed?: (s: AccountSnapshot) => Promise<void> | void;
}

export interface AccountsResult {
  snapshots: AccountSnapshot[];
  pending: PendingAccount[];
}

export const accountCacheKey = (id: VenueIdentity) => `risk:acct:${id.venue}:${id.owner.toLowerCase()}:${id.accountIndex ?? "-"}`;

/** Identities deduplicated per venue account (the same HL master or Lighter account index once). */
export function uniqueIdentities(ids: VenueIdentity[]): VenueIdentity[] {
  const seen = new Map<string, VenueIdentity>();
  for (const id of ids) {
    const k = accountCacheKey(id);
    if (!seen.has(k)) seen.set(k, { venue: id.venue, owner: id.owner, ...(id.accountIndex !== undefined ? { accountIndex: id.accountIndex } : {}) });
  }
  return [...seen.values()];
}

export async function readAccountsDetailed(ids: VenueIdentity[], deps: ReadAccountsDeps): Promise<AccountsResult> {
  const ttl = deps.ttlMs ?? ACCOUNT_TTL_MS;
  const out: AccountsResult = { snapshots: [], pending: [] };
  for (const id of uniqueIdentities(ids)) {
    if (id.venue === "aster") {
      const s = await deps.asterIngested(id.owner).catch(() => null);
      if (s) out.snapshots.push(s);
      else out.pending.push({ venue: "aster", identity: id, status: "needs_signed_read", reason: "Aster accounts are read only with your own signed read (POST /v1/risk/ingest)." });
      continue;
    }
    if (id.venue === "variational" || id.venue === "arcus") {
      out.pending.push({ venue: id.venue, identity: id, status: "excluded", reason: "This venue is data only." });
      continue;
    }
    if ((id.venue === "lighter-mainnet" || id.venue === "lighter-rh") && id.accountIndex === undefined) {
      out.pending.push({ venue: id.venue, identity: id, status: "unavailable", reason: "A Lighter account index is needed." });
      continue;
    }
    const key = accountCacheKey(id);
    const hit = await deps.cache.get(key).catch(() => null);
    if (hit) {
      out.snapshots.push(JSON.parse(hit) as AccountSnapshot);
      continue;
    }
    const a = deps.adapters.get(id.venue);
    if (!a || !a.caps.publicAccountReads) {
      out.pending.push({ venue: id.venue, identity: id, status: "unavailable", reason: "This venue's account cannot be read here." });
      continue;
    }
    try {
      const s = await a.getAccount(id);
      await deps.cache.put(key, JSON.stringify(s), ttl).catch(() => undefined);
      await deps.onRefreshed?.(s);
      out.snapshots.push(s);
    } catch (e) {
      out.pending.push({ venue: id.venue, identity: id, status: "unavailable", reason: `The venue read failed: ${(e as Error).message}`.slice(0, 200) });
    }
  }
  return out;
}

/** Spec interface: the snapshots only (see readAccountsDetailed for the pending list). */
export async function readAccounts(ids: VenueIdentity[], deps: ReadAccountsDeps): Promise<AccountSnapshot[]> {
  return (await readAccountsDetailed(ids, deps)).snapshots;
}
