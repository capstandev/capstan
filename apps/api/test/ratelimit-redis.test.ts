// The Redis window store's Lua script on a real Redis (skipped when REDIS_URL is unset). The pre-auth limiter probes
// the failure bucket with a never-written key of limit 0 (r1 F1): an empty, full window must answer "full" with a
// retry time, not throw (a throw turned every credentialed write into 503 "writes are paused" on Redis).
import { describe, expect, test } from "bun:test";
import { createRedis } from "@capstan/core";
import { redisWindowStore } from "../src/ratelimit";

const URL = process.env.REDIS_URL;

describe("redis window store", () => {
  test.skipIf(!URL)("limit-0-probe", async () => {
    const redis = createRedis(URL as string);
    try {
      const store = redisWindowStore(redis);
      const k = `rl:test:${process.pid}:${Date.now()}`;
      const now = Date.now();
      // limit 0 on a key that was never written: full, index of that key, a positive retry time
      const r = await store.take([{ key: `${k}:a`, limit: 10 }, { key: `${k}:never`, limit: 0 }], now);
      expect(r.ok).toBe(false);
      expect((r as { index: number }).index).toBe(1);
      expect((r as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
      // a full window takes nothing: the first key was not written by the refused take
      expect(await redis.zcard(`${k}:a`)).toBe(0);
      // an ordinary take still counts, and a full window says when it frees up
      expect(await store.take([{ key: `${k}:b`, limit: 1 }], now)).toEqual({ ok: true });
      const full = await store.take([{ key: `${k}:b`, limit: 1 }], now + 1);
      expect(full.ok).toBe(false);
      expect((full as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(50_000);
      await redis.del(`${k}:a`, `${k}:b`, `${k}:never`);
    } finally {
      redis.disconnect();
    }
  });
});
