// Metrics and tracing wiring (todo 37): every job run is counted per job and runs in a CONSUMER span that continues
// the producer's traceparent; the reconciler's builder fee counter moves by what a run adds (a re-run adds nothing).
import { closeDb, createDb, createRedis, createTempDatabase, logger, type JobDef } from "@capstan/core";
import { initTelemetry, metricsHandler, metricValue, SpanKind, traceJobData } from "@capstan/telemetry";
import { Queue } from "bullmq";
import { describe, expect, test } from "bun:test";
import { upsertAccrual } from "../src/reconcile/common";
import { startJobs } from "../src/runner";

const scrape = async () => (await metricsHandler()(new Request("http://127.0.0.1/metrics")).text());
const quiet = logger("t", { sink: () => {} });

describe("workers metrics", () => {
  const redisUrl = process.env.REDIS_URL;
  test.skipIf(!redisUrl)("job-run-emitted: a run is counted and traced under the producer's trace", async () => {
    const tel = initTelemetry("workers", { memory: true });
    const conn = createRedis(redisUrl!, { forBullmq: true });
    const prefix = `capstan-metrics-test-${process.pid}-${Date.now()}`;
    let done!: () => void;
    const ran = new Promise<void>((r) => (done = r));
    const job: JobDef = { name: "metrics-probe", queue: "catalogSync", concurrency: 1, handler: async () => (setTimeout(done, 20), "ok") };
    const running = await startJobs([job], { db: null, redis: null, cache: null, log: quiet, now: () => new Date() }, conn, prefix);
    const q = new Queue("catalog-sync", { connection: conn, prefix });
    const label = { key: "job", value: "metrics-probe" };
    const before = metricValue(await scrape(), "capstan_job_runs_total", label) ?? 0;
    try {
      let traceId = "";
      await tel.span("producer", async (s) => {
        traceId = s.spanContext().traceId;
        await q.add("metrics-probe", traceJobData({}));
      });
      await ran;
      expect(metricValue(await scrape(), "capstan_job_runs_total", label)).toBe(before + 1);
      const span = tel.finished().find((s) => s.name === "job metrics-probe");
      expect(span?.kind).toBe(SpanKind.CONSUMER);
      expect(span?.spanContext().traceId).toBe(traceId);
    } finally {
      await running.stop({ graceMs: 1000 });
      await q.obliterate({ force: true }).catch(() => {});
      await q.close();
      await conn.quit();
      await tel.shutdown();
    }
  }, 20_000);

  const pg = process.env.DATABASE_URL;
  test.skipIf(!pg)("builder-fee-emitted: the fee counter moves by the new accrual only", async () => {
    const tmp = await createTempDatabase(pg!, { migrated: true, prefix: "capstan_metrics" });
    const db = createDb(tmp.url, { max: 2 });
    const venue = { key: "venue", value: "hyperliquid" };
    try {
      const fee0 = metricValue(await scrape(), "capstan_builder_fee_usd_total", venue) ?? 0;
      const a = { day: "2026-11-05", venue: "hyperliquid" as const, builder: "0x00000000000000000000000000000000000000b0" as const, fills: 2, notionalUsd: "1000", feeUsd: "10", unmatchedFills: 0, source: "hl_userfills" as const };
      await upsertAccrual(db, a);
      expect(metricValue(await scrape(), "capstan_builder_fee_usd_total", venue)).toBe(fee0 + 10);
      await upsertAccrual(db, a); // re-run of the same day
      expect(metricValue(await scrape(), "capstan_builder_fee_usd_total", venue)).toBe(fee0 + 10);
      await upsertAccrual(db, { ...a, feeUsd: "12.5" });
      expect(metricValue(await scrape(), "capstan_builder_fee_usd_total", venue)).toBe(fee0 + 12.5);
    } finally {
      await closeDb(db);
      await tmp.drop();
    }
  }, 60_000);
});
