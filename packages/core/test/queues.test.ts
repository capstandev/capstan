// R19: upsertSchedule is idempotent (needs REDIS_URL; skips without it).
import { afterAll, describe, expect, test } from "bun:test";
import { createQueue, QUEUES, upsertSchedule } from "../src/queues";
import { createRedis } from "../src/redis";

const URL_ = process.env.REDIS_URL;
const d = URL_ ? describe : describe.skip;

describe("queue names", () => {
  test("no ':' in any queue name (BullMQ refuses it)", () => {
    for (const n of Object.values(QUEUES)) expect(n).not.toContain(":");
    expect(new Set(Object.values(QUEUES)).size).toBe(Object.keys(QUEUES).length);
  });
});

d("queues (redis)", () => {
  const redis = URL_ ? createRedis(URL_, { forBullmq: true }) : null;
  const prefix = `capstan-test-${process.pid}`;
  afterAll(async () => {
    if (!redis) return;
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  test("idempotent-scheduler", async () => {
    const q = createQueue("catalogSync", redis!, prefix);
    try {
      await upsertSchedule(q, "catalog-sync", { pattern: "15 0 * * *" });
      await upsertSchedule(q, "catalog-sync", { pattern: "15 0 * * *" });
      const s = await q.getJobSchedulers();
      expect(s.length).toBe(1);
      expect(s[0]!.key).toBe("catalog-sync");
      expect(s[0]!.pattern).toBe("15 0 * * *");
      expect(s[0]!.tz).toBe("UTC");
      await upsertSchedule(q, "catalog-sync", { pattern: "20 0 * * *" });
      const s2 = await q.getJobSchedulers();
      expect(s2.length).toBe(1);
      expect(s2[0]!.pattern).toBe("20 0 * * *");
      await expect(upsertSchedule(q, "x", {})).rejects.toThrow("exactly one of pattern or every");
    } finally {
      await q.obliterate({ force: true });
      await q.close();
    }
  });
});
