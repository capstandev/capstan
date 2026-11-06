// Worker runner: loads every src/jobs/*.job.ts (sorted glob scan), keeps the ones named in WORKER_JOBS (comma list;
// empty = all), refuses to start on an unknown name, upserts each job's schedule and starts one BullMQ Worker per job.
import { createQueue, QUEUES, upsertSchedule, type JobDef, type JobDeps, type Queue, type Redis } from "@capstan/core";
import { Worker } from "bullmq";
import { join } from "node:path";

export const JOBS_DIR = join(import.meta.dir, "jobs");

export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerError";
  }
}

function validateJob(j: unknown, file: string): JobDef {
  const d = j as Partial<JobDef> | null;
  if (!d || typeof d.name !== "string" || !d.name) throw new RunnerError(`${file}: job has no name`);
  if (!d.queue || !(d.queue in QUEUES)) throw new RunnerError(`${file}: job ${d.name} has an unknown queue`);
  if (typeof d.handler !== "function") throw new RunnerError(`${file}: job ${d.name} has no handler`);
  if (!Number.isInteger(d.concurrency) || (d.concurrency as number) < 1) throw new RunnerError(`${file}: job ${d.name} needs concurrency >= 1`);
  return d as JobDef;
}

export async function discoverJobs(dir = JOBS_DIR): Promise<JobDef[]> {
  const files: string[] = [];
  for await (const f of new Bun.Glob("*.job.ts").scan({ cwd: dir, onlyFiles: true })) files.push(f);
  files.sort();
  const jobs: JobDef[] = [];
  const names = new Set<string>();
  for (const f of files) {
    const mod = (await import(join(dir, f))) as { job?: unknown };
    const job = validateJob(mod.job, f);
    if (names.has(job.name)) throw new RunnerError(`${f}: duplicate job name ${job.name}`);
    names.add(job.name);
    jobs.push(job);
  }
  return jobs;
}

/** WORKER_JOBS must be a subset of the discovered names; empty means every job. */
export function selectJobs(all: JobDef[], workerJobs: string | undefined): JobDef[] {
  const wanted = (workerJobs ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!wanted.length) return all;
  const known = new Set(all.map((j) => j.name));
  const unknown = wanted.filter((w) => !known.has(w));
  if (unknown.length) throw new RunnerError(`unknown job ${unknown.join(", ")} (known: ${[...known].join(", ") || "none"})`);
  return all.filter((j) => wanted.includes(j.name));
}

export interface Running {
  workers: Worker[];
  stop(): Promise<void>;
}

/**
 * Start one Worker per queue that dispatches by job name. Several jobs share a queue (reconcile-daily hosts many), and
 * BullMQ hands any job on a queue to any worker on it, so a worker per job name would complete other jobs' runs
 * without running them. A name with no handler here fails loudly instead.
 */
export async function startJobs(jobs: JobDef[], deps: JobDeps, connection: Redis, prefix = "capstan"): Promise<Running> {
  const workers: Worker[] = [];
  const queues: Queue[] = [];
  const byQueue = new Map<JobDef["queue"], JobDef[]>();
  for (const job of jobs) byQueue.set(job.queue, [...(byQueue.get(job.queue) ?? []), job]);
  for (const [key, group] of byQueue) {
    const q = createQueue(key, connection, prefix);
    queues.push(q);
    for (const job of group) if (job.schedule) await upsertSchedule(q, job.name, job.schedule);
    const handlers = new Map(group.map((j) => [j.name, j]));
    const w = new Worker(
      QUEUES[key],
      async (bj) => {
        const job = handlers.get(bj.name);
        if (!job) throw new RunnerError(`no handler for job ${bj.name} on queue ${QUEUES[key]} in this worker`);
        return job.handler(bj, { ...deps, log: deps.log.child({ job: job.name }) });
      },
      { connection, prefix, concurrency: group.reduce((n, j) => n + j.concurrency, 0) },
    );
    w.on("failed", (bj, err) => deps.log.error("job failed", { job: bj?.name, id: bj?.id, error: err.message }));
    workers.push(w);
  }
  return {
    workers,
    async stop() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(queues.map((q) => q.close()));
    },
  };
}
