// Metrics and tracing wiring (todo 37): a relay submit moves the funnel "submit" counter and the governor gauge, a
// refusal is counted by code, and a submit enqueued under an api request span is continued by the relay worker in
// the same trace (traceparent in the job data).
import { createRedis } from "@capstan/core";
import { initTelemetry, metricsHandler, metricValue, SpanKind } from "@capstan/telemetry";
import { afterAll, describe, expect, test } from "bun:test";
import { relayFlags } from "../src/flags";
import { handleSubmit } from "../src/pipeline";
import { relayQueueClient, startRelayWorker } from "../src/queue";
import { codeOf, relayStack } from "./helpers";

const scrape = async () => (await metricsHandler()(new Request("http://127.0.0.1/metrics")).text());
const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));

describe("relay metrics", () => {
  test("submit-emitted: funnel submit, governor use and refusals by code", async () => {
    const s = relayStack();
    stacks.push(s);
    const ip = { ip: "203.0.113.82" };
    const submit0 = metricValue(await scrape(), "capstan_order_funnel_total", { key: "stage", value: "submit" }) ?? 0;
    const h = await s.hl();
    expect((await codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, ip, s.deps))).code).toBeNull();
    let text = await scrape();
    expect(metricValue(text, "capstan_order_funnel_total", { key: "stage", value: "submit" })).toBe(submit0 + 1);
    expect(text).toMatch(/^capstan_governor_use_pct\{budget="test-egress:[^"]+"\} \d/m);
    // an unarmed relay refuses: counted under its code, and the funnel does not move
    const refused0 = metricValue(text, "capstan_relay_refusals_total", { key: "code", value: "VENUE_ERROR" }) ?? 0;
    s.deps.flags = relayFlags({});
    const h2 = await s.hl();
    expect((await codeOf(handleSubmit({ buildId: h2.b.buildId, signedEnvelope: h2.env }, ip, s.deps))).code).toBe("VENUE_ERROR");
    text = await scrape();
    expect(metricValue(text, "capstan_relay_refusals_total", { key: "code", value: "VENUE_ERROR" })).toBe(refused0 + 1);
    expect(metricValue(text, "capstan_order_funnel_total", { key: "stage", value: "submit" })).toBe(submit0 + 1);
  });

  const redisUrl = process.env.REDIS_URL;
  test.skipIf(!redisUrl)("api-relay-trace: the relay worker continues the api request's trace through the queue", async () => {
    const s = relayStack();
    stacks.push(s);
    const tel = initTelemetry("relay", { memory: true });
    const conn = createRedis(redisUrl!, { forBullmq: true });
    const prefix = `capstan-trace-test-${process.pid}-${Date.now()}`;
    const worker = startRelayWorker(conn, s.deps, { prefix });
    const client = relayQueueClient(conn, { prefix });
    try {
      const h = await s.hl();
      let traceId = "";
      const r = await tel.span(
        "POST /v1/orders/submit",
        async (span) => {
          traceId = span.spanContext().traceId;
          return client.submit({ buildId: h.b.buildId, signedEnvelope: h.env, ip: "203.0.113.83" }, "pro", `trace-${Date.now()}`);
        },
        { kind: SpanKind.SERVER },
      );
      expect("queued" in r ? r : r.ok).toBe(true);
      const relaySpan = tel.finished().find((x) => x.name === "relay submit");
      expect(relaySpan).toBeDefined();
      expect(relaySpan!.kind).toBe(SpanKind.CONSUMER);
      expect(relaySpan!.spanContext().traceId).toBe(traceId);
    } finally {
      await client.close();
      await worker.close();
      await conn.quit();
      await tel.shutdown();
    }
  }, 20_000);
});
