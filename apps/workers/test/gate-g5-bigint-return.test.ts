// Release gate 2026-11-08 G-5: root-indexer returned { to: head } with a bigint. BullMQ stores return values as JSON,
// so every run was marked failed although its rows were written, and real failures hid in the noise. The runner now
// stores any bigint as a decimal string, and root-indexer returns a number. Needs REDIS_URL.
import { describe, expect, test } from "bun:test";
import { createQueue, createRedis, logger, type JobDef } from "@capstan/core";
import { QueueEvents } from "bullmq";
import { startJobs } from "../src/runner";

describe.skipIf(!process.env.REDIS_URL)("gate G-5: a bigint return value", () => {
  test("bigint-return: the run completes and stores the value", async () => {
    const redis = createRedis(process.env.REDIS_URL!, { forBullmq: true });
    const prefix = `capstan-g5-t${process.pid}`;
    const failed: string[] = [];
    const job: JobDef = { name: "g5-bigint", queue: "anchorHourly", concurrency: 1, handler: async () => ({ to: 12_345_678_901n, found: 2 }) };
    const r = await startJobs([job], { db: null, redis: null, cache: null, log: logger("t", { sink: () => {} }), now: () => new Date() }, redis, prefix);
    r.workers[0]!.on("failed", (_j, e) => void failed.push(e.message));
    const q = createQueue("anchorHourly", redis, prefix);
    const events = new QueueEvents(q.name, { connection: redis.duplicate(), prefix });
    try {
      await events.waitUntilReady();
      const j = await q.add("g5-bigint", {});
      const out = await j.waitUntilFinished(events, 5_000);
      expect(out).toEqual({ to: "12345678901", found: 2 });
      expect(failed).toEqual([]);
    } finally {
      await r.stop();
      await events.close();
      await q.obliterate({ force: true });
      await q.close();
      redis.disconnect();
    }
  }, 30_000);
});
