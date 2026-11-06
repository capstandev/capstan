// Jobs that share a queue each run their own scheduled work. Before the fix the runner started one worker per job
// name on the shared queue and a worker returned early for other names, so BullMQ marked those runs complete without
// running them (9 runs of one job queued: 2 ran). Needs REDIS_URL.
import { describe, expect, test } from "bun:test";
import { createQueue, createRedis, logger, type JobDef } from "@capstan/core";
import { startJobs } from "../src/runner";

describe.skipIf(!process.env.REDIS_URL)("runner on a shared queue", () => {
  test("shared-queue: every run reaches its own handler", async () => {
    const redis = createRedis(process.env.REDIS_URL!, { forBullmq: true });
    const ran: string[] = [];
    const mk = (name: string): JobDef => ({ name, queue: "reconcileDaily", concurrency: 1, handler: async () => void ran.push(name) });
    const prefix = `capstan-runner-t${process.pid}`;
    const r = await startJobs([mk("a"), mk("b"), mk("c")], { db: null, redis: null, cache: null, log: logger("t", { sink: () => {} }), now: () => new Date() }, redis, prefix);
    const q = createQueue("reconcileDaily", redis, prefix);
    try {
      for (let i = 0; i < 9; i++) await q.add("b", {});
      await q.add("a", {});
      const until = Date.now() + 10_000;
      while (ran.length < 10 && Date.now() < until) await Bun.sleep(50);
      expect(ran.filter((x) => x === "b")).toHaveLength(9);
      expect(ran.filter((x) => x === "a")).toHaveLength(1);
      expect(r.workers).toHaveLength(1); // one worker per queue
    } finally {
      await r.stop();
      await q.obliterate({ force: true });
      await q.close();
      redis.disconnect();
    }
  }, 30_000);
});
