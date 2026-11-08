// Per-owner limits on the user alert queue (R1-8-03), kept in Redis so they hold across every worker process:
//   - one alert a wallet can cause itself (plan_unhedged, policy_breach) runs at a time per owner, so one wallet never
//     holds more than one worker slot; a second one waits a moment and runs after it;
//   - a webhook that answers slower than SLOW_MS on SLOW_DISABLE_AFTER deliveries in a row is turned off, not only one
//     that fails (the streak lives in Redis: losing it only delays turning a slow hook off).
import type { Redis } from "@capstan/core";
import { randomBytes } from "node:crypto";

/** A delivery whose slowest attempt took longer than this counts as slow. */
export const SLOW_MS = 2000;
export const SLOW_DISABLE_AFTER = 3;
/** How long a busy owner's next alert waits before it is tried again. */
export const OWNER_BUSY_DELAY_MS = 1000;

export interface SlowStreak {
  /** Count one more slow delivery in a row for this webhook; returns the streak. */
  bump(webhookId: string): Promise<number>;
  clear(webhookId: string): Promise<void>;
}

export interface OwnerLock {
  /** Take the owner's slot for at most ttlMs; null when another alert of the owner holds it. */
  take(owner: string, ttlMs: number): Promise<{ release(): Promise<void> } | null>;
}

const KEY = "capstan:alerts";
const STREAK_TTL_S = 7 * 24 * 3600;
// delete the key only while it still holds our token (a lock that expired and was taken again is left alone)
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export function redisSlowStreak(redis: Redis): SlowStreak {
  return {
    async bump(id) {
      const k = `${KEY}:slow:${id}`;
      const n = await redis.incr(k);
      await redis.expire(k, STREAK_TTL_S);
      return n;
    },
    async clear(id) {
      await redis.del(`${KEY}:slow:${id}`);
    },
  };
}

export function redisOwnerLock(redis: Redis): OwnerLock {
  return {
    async take(owner, ttlMs) {
      const k = `${KEY}:owner:${owner.toLowerCase()}`;
      const token = randomBytes(12).toString("hex");
      const ok = await redis.set(k, token, "PX", Math.max(1, Math.ceil(ttlMs)), "NX");
      if (ok !== "OK") return null;
      return { release: async () => void (await redis.eval(RELEASE, 1, k, token)) };
    },
  };
}

export function memorySlowStreak(): SlowStreak {
  const m = new Map<string, number>();
  return {
    async bump(id) {
      const n = (m.get(id) ?? 0) + 1;
      m.set(id, n);
      return n;
    },
    async clear(id) {
      m.delete(id);
    },
  };
}
