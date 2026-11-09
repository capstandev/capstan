// Worker runner: loads every src/jobs/*.job.ts (sorted glob scan), keeps the ones named in WORKER_JOBS (comma list;
// empty = all), refuses to start on an unknown name, upserts each job's schedule and starts one BullMQ Worker per job.
import { SERVICE_METRICS, traceFromJob } from "@capstan/telemetry";
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
  /**
   * Stop taking jobs; wait up to graceMs (default: no cap) for running ones, then force-close the workers (an
   * unfinished job goes back as stalled and is picked up again). Then close the queues.
   */
  stop(o?: { graceMs?: number }): Promise<{ forced: boolean }>;
}

/**
 * A job's return value as BullMQ can store it (JSON). A bigint anywhere in it made BullMQ mark a run failed after the
 * handler had done its work (gate G-5), so real failures hid among false ones: bigints become decimal strings.
 */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v === null || typeof v !== "object") return v;
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

/** Job schedulers that once lived on a queue and moved away: removed from the old queue at start. */
export const MOVED_SCHEDULERS: Partial<Record<JobDef["queue"], string[]>> = { alertsDispatch: ["ops-alerts"] }; // R1-8-03

/**
 * Start one Worker per queue that dispatches by job name. Several jobs share a queue (reconcile-daily hosts many), and
 * BullMQ hands any job on a queue to any worker on it, so a worker per job name would complete other jobs' runs
 * without running them. A name with no handler here fails loudly instead.
 */
export async function startJobs(jobs: JobDef[], deps: JobDeps, connection: Redis, prefix = "capstan"): Promise<Running> {
  const workers: Worker[] = [];
  const queues: Queue[] = [];
  const byQueue = new Map<JobDef["queue"], JobDef[]>();
  // running handler promises, so a bounded stop can wait for them without asking BullMQ
  const active = new Set<Promise<unknown>>();
  const waitIdle = async (ms: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
    const all = Promise.allSettled([...active]).then(() => true);
    const r = await Promise.race([all, cap]);
    clearTimeout(timer);
    return r && active.size === 0;
  };
  for (const job of jobs) byQueue.set(job.queue, [...(byQueue.get(job.queue) ?? []), job]);
  for (const [key, group] of byQueue) {
    const q = createQueue(key, connection, prefix);
    queues.push(q);
    for (const job of group) if (job.schedule) await upsertSchedule(q, job.name, job.schedule);
    // schedulers a job left behind when it moved to another queue (a name with no handler here would fail every run)
    for (const id of MOVED_SCHEDULERS[key] ?? []) await q.removeJobScheduler(id);
    const handlers = new Map(group.map((j) => [j.name, j]));
    const w = new Worker(
      QUEUES[key],
      async (bj, token) => {
        const job = handlers.get(bj.name);
        if (!job) throw new RunnerError(`no handler for job ${bj.name} on queue ${QUEUES[key]} in this worker`);
        // one CONSUMER span per run (continuing the producer's trace when the job carries one) and run counters
        const run = traceFromJob(bj.data as { traceparent?: unknown } | null, `job ${job.name}`, () => job.handler(bj, { ...deps, log: deps.log.child({ job: job.name }), ...(token ? { token } : {}) }));
        active.add(run);
        try {
          const r = await run;
          SERVICE_METRICS.jobRuns.inc(job.name);
          return jsonSafe(r);
        } catch (e) {
          // a job moved back to delayed on purpose (DelayedError) is not a failure
          if ((e as Error)?.name !== "DelayedError") SERVICE_METRICS.jobFailures.inc(job.name);
          throw e;
        } finally {
          active.delete(run);
        }
      },
      { connection, prefix, concurrency: group.reduce((n, j) => n + j.concurrency, 0) },
    );
    w.on("failed", (bj, err) => deps.log.error("job failed", { job: bj?.name, id: bj?.id, error: err.message }));
    workers.push(w);
  }
  return {
    workers,
    async stop(o = {}) {
      let forced = false;
      if (o.graceMs === undefined) await Promise.all(workers.map((w) => w.close()));
      else {
        // BullMQ caches the first close() promise, so a graceful close cannot be upgraded to a forced one later:
        // pause fetching first, wait for the running jobs within the grace period, then close once (forced if any
        // job is still running; it goes back as stalled and another worker runs it)
        await Promise.all(workers.map((w) => w.pause(true)));
        const idle = active.size === 0 || (await waitIdle(o.graceMs));
        forced = !idle;
        await Promise.all(workers.map((w) => w.close(forced)));
      }
      await Promise.all(queues.map((q) => q.close()));
      return { forced };
    },
  };
}
