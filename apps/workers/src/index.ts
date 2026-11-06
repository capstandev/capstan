// @capstan/workers entry: `WORKER_JOBS=catalog-sync bun apps/workers/src/index.ts`. Validates config, picks the jobs,
// refuses an unknown job name before connecting to anything, then runs the workers until SIGTERM.
import { createDb, createMarketDataCache, createRedis, loadConfig, logger } from "@capstan/core";
import { discoverJobs, selectJobs, startJobs } from "./runner";

export * from "./runner";

if (import.meta.main) {
  const log = logger("workers");
  try {
    const cfg = loadConfig("workers");
    const jobs = selectJobs(await discoverJobs(), cfg.WORKER_JOBS);
    const redis = createRedis(cfg.REDIS_URL, { forBullmq: true });
    const db = createDb(cfg.DATABASE_URL);
    const running = await startJobs(jobs, { db, redis, cache: createMarketDataCache(redis), log, now: () => new Date() }, redis);
    log.info("workers running", { jobs: jobs.map((j) => j.name) });
    const stop = async () => {
      await running.stop();
      await redis.quit();
      await db.$client.end({ timeout: 5 });
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (e) {
    console.error(`workers: ${(e as Error).message}`);
    process.exit(1);
  }
}
