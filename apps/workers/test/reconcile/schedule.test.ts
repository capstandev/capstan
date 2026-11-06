// R12: the job runs daily at 02:00 UTC as the Job Scheduler `builder-reconciler`.
import { describe, expect, test } from "bun:test";
import { createQueue, createRedis, upsertSchedule } from "@capstan/core";
import { discoverJobs } from "../../src/runner";
import { job, RECONCILER_SCHEDULE } from "../../src/jobs/builder-reconciler.job";

describe("builder-reconciler schedule", () => {
  test("schedule", async () => {
    expect(job.name).toBe("builder-reconciler");
    expect(job.queue).toBe("reconcileDaily");
    expect(job.schedule).toEqual({ pattern: "0 2 * * *" });
    expect(RECONCILER_SCHEDULE.pattern).toBe("0 2 * * *");
    expect((await discoverJobs()).some((j) => j.name === "builder-reconciler")).toBe(true);
    if (!process.env.REDIS_URL) return;
    const redis = createRedis(process.env.REDIS_URL, { forBullmq: true });
    const q = createQueue("reconcileDaily", redis, `capstan-sched-t${process.pid}`);
    try {
      await upsertSchedule(q, job.name, job.schedule!);
      await upsertSchedule(q, job.name, job.schedule!); // twice: still one scheduler
      const s = await q.getJobSchedulers();
      expect(s).toHaveLength(1);
      expect(s[0]).toMatchObject({ key: "builder-reconciler", pattern: "0 2 * * *", tz: "UTC" });
      const next = new Date(Number(s[0]!.next));
      expect(next.getUTCHours()).toBe(2);
      expect(next.getUTCMinutes()).toBe(0);
    } finally {
      await q.obliterate({ force: true });
      await q.close();
      redis.disconnect();
    }
  });
});
