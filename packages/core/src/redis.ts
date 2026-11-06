// Redis client factory (ioredis 5). BullMQ needs maxRetriesPerRequest = null on worker connections.
import { Redis } from "ioredis";
import type { NonceStore } from "./signed-message";

export type { Redis };

export function createRedis(url: string, opts?: { forBullmq?: boolean; lazyConnect?: boolean }): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: opts?.forBullmq ? null : 3,
    enableReadyCheck: true,
    lazyConnect: opts?.lazyConnect ?? false,
  });
}

/** Nonce store on Redis: SET NX with an expiry a little longer than the longest message validity. */
export function redisNonceStore(redis: Redis, ttlMs = 25 * 60 * 60 * 1000): NonceStore {
  return {
    async seen(nonce) {
      const r = await redis.set(`nonce:${nonce}`, "1", "PX", ttlMs, "NX");
      return r !== "OK";
    },
  };
}
