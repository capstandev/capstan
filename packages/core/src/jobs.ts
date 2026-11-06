// Drop-in worker job contract: apps/workers/src/jobs/<name>.job.ts exports `job: JobDef`.
import type { Job } from "bullmq";
import type { MarketDataCache } from "./cache";
import type { Db } from "./db";
import type { Logger } from "./logger";
import type { QUEUES, Schedule } from "./queues";
import type { Redis } from "./redis";

export interface JobDeps {
  db: Db | null;
  redis: Redis | null;
  cache: MarketDataCache | null;
  log: Logger;
  now: () => Date;
  publish?: (channel: string, payload: unknown) => Promise<void>;
}

export interface JobDef {
  name: string;
  queue: keyof typeof QUEUES;
  schedule?: Schedule;
  concurrency: number;
  handler(job: Job, deps: JobDeps): Promise<unknown>;
}
