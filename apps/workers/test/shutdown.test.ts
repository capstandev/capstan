// Workers stop within 3 s of SIGTERM: running jobs get a grace period, then the workers are force-closed, and the
// queues, telemetry, Redis and the database close under their own caps. Fakes cover hung clients; a real BullMQ
// worker with a 60 s job and the real entry point under SIGTERM run when REDIS_URL and DATABASE_URL are set.
import { createRedis, logger, type JobDef } from "@capstan/core";
import { Queue } from "bullmq";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startJobs, type Running } from "../src/runner";
import { SHUTDOWN_DEADLINE_MS, shutdownWorkers } from "../src/shutdown";

const never = () => new Promise<never>(() => {});
const quiet = logger("t", { sink: () => {} });

describe("workers shutdown", () => {
  test("bounded-when-everything-hangs: hung workers, telemetry, Redis and database still finish under the deadline", async () => {
    let forcedClose = false;
    let disconnected = false;
    const running: Running = {
      workers: [],
      async stop(o) {
        await new Promise((r) => setTimeout(r, o?.graceMs ?? 0));
        forcedClose = true;
        return { forced: true };
      },
    };
    const t0 = Date.now();
    const r = await shutdownWorkers({
      running,
      telemetry: { shutdown: never },
      redis: { quit: never, disconnect: () => void (disconnected = true) },
      db: { $client: { end: never } },
    });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(3000);
    expect(ms).toBeLessThanOrEqual(SHUTDOWN_DEADLINE_MS + 100);
    expect(r.forced).toEqual(["workers", "telemetry", "redis", "db"]);
    expect(forcedClose).toBe(true);
    expect(disconnected).toBe(true);
  });

  test("clean-when-idle: nothing forced when every step answers", async () => {
    const order: string[] = [];
    const r = await shutdownWorkers({
      running: { workers: [], stop: async () => (order.push("workers"), { forced: false }) },
      telemetry: { shutdown: async () => void order.push("telemetry") },
      redis: { quit: async () => order.push("redis"), disconnect: () => order.push("disconnect") },
      db: { $client: { end: async () => void order.push("db") } },
    });
    expect(r.forced).toEqual([]);
    expect(order).toEqual(["workers", "telemetry", "redis", "db"]);
  });

  const redisUrl = process.env.REDIS_URL;
  test.skipIf(!redisUrl)("long-job-force-closed: a 60 s job does not hold the stop past the deadline (real BullMQ)", async () => {
    const conn = createRedis(redisUrl!, { forBullmq: true });
    const prefix = `capstan-shutdown-test-${process.pid}-${Date.now()}`;
    let started!: () => void;
    const active = new Promise<void>((r) => (started = r));
    const slow: JobDef = { name: "slow-job", queue: "catalogSync", concurrency: 1, handler: async () => (started(), await new Promise((r) => setTimeout(r, 60_000))) };
    const running = await startJobs([slow], { db: null, redis: null, cache: null, log: quiet, now: () => new Date() }, conn, prefix);
    const q = new Queue("catalog-sync", { connection: conn, prefix });
    try {
      await q.add("slow-job", {});
      await active;
      const t0 = Date.now();
      const r = await shutdownWorkers({ running, redis: { quit: async () => "OK", disconnect: () => {} }, db: { $client: { end: async () => {} } } });
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(r.forced).toEqual(["workers"]);
    } finally {
      await q.obliterate({ force: true }).catch(() => {});
      await q.close();
      await conn.quit();
    }
  }, 20_000);

  const dbUrl = process.env.DATABASE_URL;
  test.skipIf(!redisUrl || !dbUrl)("sigterm-exits-within-3s: the entry point exits 0 within 3 s of SIGTERM", async () => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
      env: { ...process.env, WORKER_JOBS: "log-retention", ANCHOR_SIGNER: "dev", LOG_LEVEL: "info", PROM_PORT: "", OTLP_FILE: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = p.stdout.getReader();
    let out = "";
    const deadline = Date.now() + 15_000;
    while (!out.includes("workers running") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain("workers running");
    const t0 = Date.now();
    p.kill("SIGTERM");
    const code = await p.exited;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(code).toBe(0);
  }, 30_000);
});
