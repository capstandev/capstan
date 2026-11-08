// The ws gateway's catalog read and per-owner subscription cap, kept apart from the entry so tests can drive them.
import { logger, type Db } from "@capstan/core";
import { LIMITS, tierOf, type LockReader } from "@capstan/plans";
import type { Hex } from "@capstan/schema";

export interface Catalog {
  at: number;
  markets: Set<string>;
  assets: Set<string>;
}

/**
 * The catalog's market ids and canonical assets, read at most once per ttl (r1 F6: only these may be subscribed).
 * One read is shared by concurrent callers. A failed read never rejects (R2-GW-1): it keeps the last good copy, or
 * answers an empty catalog so unknown ids are refused, and retries on the next call.
 */
export function catalogReader(read: () => Promise<{ id: string; asset: string | null }[]>, opts: { ttlMs?: number; now?: () => number } = {}): () => Promise<Catalog> {
  const ttl = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const log = logger("ws");
  let good: Catalog | null = null;
  let inflight: Promise<Catalog> | null = null;
  return () => {
    if (good && now() - good.at < ttl) return Promise.resolve(good);
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const rows = await read();
        good = { at: now(), markets: new Set(rows.map((r) => r.id)), assets: new Set(rows.map((r) => r.asset).filter((a): a is string => !!a)) };
        return good;
      } catch (e) {
        log.error("catalog read failed", { error: (e as Error).message, kept: good ? "last good" : "empty" });
        return good ?? { at: 0, markets: new Set<string>(), assets: new Set<string>() };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

/** Anonymous and free connections get defaultCap; a signed owner gets its tier's cap, lock tiers included (r1:3 F9). */
export function wsCapOf(deps: { db: Db | null; lock: LockReader; defaultCap: number }): (owner: Hex | null) => Promise<number> {
  return async (owner) => {
    if (!owner) return deps.defaultCap;
    const t = await tierOf({ owner }, { db: deps.db, lock: deps.lock, cacheTtlMs: 60_000 }).catch(() => null);
    return Math.max(deps.defaultCap, LIMITS[t?.tier ?? "free"].wsSubs);
  };
}
