// Graceful worker shutdown on SIGTERM, bounded so systemd (and a deploy restart) never waits on a long job: stop
// taking jobs and give running ones a grace period, then force-close the workers (BullMQ marks an unfinished job
// stalled and another worker picks it up, so nothing is lost), close the queues, telemetry, Redis and the database,
// each with its own time cap. The whole sequence stays under SHUTDOWN_DEADLINE_MS.
import type { Running } from "./runner";

export const SHUTDOWN_DEADLINE_MS = 2_500;

export interface ShutdownParts {
  running: Running;
  telemetry?: { shutdown(): Promise<void> };
  redis: { quit(): Promise<unknown>; disconnect(): void };
  db: { $client: { end(o?: { timeout?: number }): Promise<void> } };
  log?: { info(msg: string, f?: Record<string, unknown>): void; warn(msg: string, f?: Record<string, unknown>): void };
}

export interface ShutdownResult {
  ms: number;
  /** Steps that hit their cap and were cut (forced close or disconnect). */
  forced: string[];
}

/** Resolve true when p settles within ms, false when the cap hits first (p keeps running, its result is dropped). */
export async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
  try {
    return await Promise.race([p.then(() => true, () => true), cap]);
  } finally {
    clearTimeout(timer);
  }
}

export async function shutdownWorkers(p: ShutdownParts, o: { deadlineMs?: number; now?: () => number } = {}): Promise<ShutdownResult> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const deadline = o.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  const left = (share: number) => Math.max(50, Math.min(share, deadline - (now() - t0)));
  const forced: string[] = [];
  // 1: workers. Most of the budget goes to letting running jobs finish; the rest is fixed caps.
  const stopped = await p.running.stop({ graceMs: left(Math.floor(deadline * 0.6)) });
  if (stopped.forced) forced.push("workers");
  // 2: telemetry (flushes spans to the file)
  if (p.telemetry && !(await within(p.telemetry.shutdown(), left(200)))) forced.push("telemetry");
  // 3: Redis: QUIT, else drop the socket
  if (!(await within(p.redis.quit(), left(200)))) {
    p.redis.disconnect();
    forced.push("redis");
  }
  // 4: the database pool (postgres.js waits `timeout` seconds for running queries, then closes)
  if (!(await within(p.db.$client.end({ timeout: 0.2 }), left(400)))) forced.push("db");
  const ms = now() - t0;
  p.log?.[forced.length ? "warn" : "info"]("workers stopped", { ms, forced });
  return { ms, forced };
}

/** SIGTERM and SIGINT handlers: one shutdown at a time, then exit; a watchdog exits anyway at the deadline + 400 ms. */
export function onStopSignals(stop: () => Promise<unknown>, o: { deadlineMs?: number; exit?: (code: number) => void } = {}): void {
  const exit = o.exit ?? ((c: number) => process.exit(c));
  let stopping = false;
  const handler = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => exit(1), (o.deadlineMs ?? SHUTDOWN_DEADLINE_MS) + 400).unref();
    stop().then(
      () => exit(0),
      () => exit(1),
    );
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}
