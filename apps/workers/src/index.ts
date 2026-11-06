// @capstan/workers entry: `WORKER_JOBS=catalog-sync bun apps/workers/src/index.ts`. Validates config, picks the jobs,
// refuses an unknown job name before connecting to anything, then runs the workers until SIGTERM.
import { createDb, createMarketDataCache, createRedis, loadConfig, logger } from "@capstan/core";
import { initTelemetry, telemetryEnv } from "@capstan/telemetry";
import { discoverJobs, selectJobs, startJobs } from "./runner";
import { onStopSignals, shutdownWorkers } from "./shutdown";

export * from "./runner";
export * from "./shutdown";

if (import.meta.main) {
  const log = logger("workers");
  try {
    const cfg = loadConfig("workers");
    const tel = initTelemetry("workers", telemetryEnv(process.env)); // traces + /metrics
    const jobs = selectJobs(await discoverJobs(), cfg.WORKER_JOBS);
    const redis = createRedis(cfg.REDIS_URL, { forBullmq: true });
    const db = createDb(cfg.DATABASE_URL);
    const running = await startJobs(jobs, { db, redis, cache: createMarketDataCache(redis), log, now: () => new Date() }, redis);
    log.info("workers running", { jobs: jobs.map((j) => j.name) });
    // SIGTERM: bounded graceful stop (workers, queues, telemetry, Redis, database), then exit 0 within 3 s
    onStopSignals(() => shutdownWorkers({ running, telemetry: tel, redis, db, log }));
  } catch (e) {
    console.error(`workers: ${(e as Error).message}`);
    process.exit(1);
  }
}
