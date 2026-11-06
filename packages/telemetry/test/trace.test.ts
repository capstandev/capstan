import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { initTelemetry } from "../src";

describe("trace", () => {
  const seen: (string | null)[] = [];
  const venue = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(req.headers.get("traceparent")), Response.json({ status: "ok" })) });
  afterAll(() => venue.stop(true));

  test("api-relay-venue: one trace id from POST /v1/orders/submit through the relay worker to the venue submit", async () => {
    const api = initTelemetry("api", { memory: true });
    const relay = initTelemetry("relay", { memory: true });
    const queue: Record<string, unknown>[] = [];
    const app = new Hono();
    app.post("/v1/orders/submit", (c) => {
      queue.push(api.jobData({ buildId: "b1" })); // the relay-submit job carries the trace
      return c.json({ status: "queued" });
    });
    const callerTrace = "4bf92f3577b34da6a3ce929d0e0e4736";
    const res = await api.serve(app.fetch)(new Request("http://127.0.0.1/v1/orders/submit", { method: "POST", headers: { traceparent: `00-${callerTrace}-00f067aa0ba902b7-01` } }));
    expect(res.status).toBe(200);
    expect(queue[0]!.traceparent).toMatch(new RegExp(`^00-${callerTrace}-[0-9a-f]{16}-01$`));

    // relay worker: continue the trace, adapter submit span, venue call with traceparent
    await relay.fromJob(queue[0], "relay.submit", () =>
      relay.span("adapter.submit", async () => {
        const f = relay.venueFetch("hyperliquid");
        const r = await f(`http://127.0.0.1:${venue.port}/exchange`, { method: "POST", body: "{}" });
        expect(r.status).toBe(200);
      }),
    );

    const apiSpans = api.finished();
    const relaySpans = relay.finished();
    const server = apiSpans.find((s) => s.name === "POST /v1/orders/submit")!;
    const worker = relaySpans.find((s) => s.name === "relay.submit")!;
    const submit = relaySpans.find((s) => s.name === "adapter.submit")!;
    const client = relaySpans.find((s) => s.name === "venue hyperliquid")!;
    for (const s of [server, worker, submit, client]) expect(s.spanContext().traceId).toBe(callerTrace);
    // parent chain: server -> worker -> adapter.submit -> venue client
    expect(worker.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(submit.parentSpanContext?.spanId).toBe(worker.spanContext().spanId);
    expect(client.parentSpanContext?.spanId).toBe(submit.spanContext().spanId);
    // the venue received the same trace id, with the client span as parent
    expect(seen.at(-1)).toBe(`00-${callerTrace}-${client.spanContext().spanId}-01`);
    await api.shutdown();
    await relay.shutdown();
  });

  test("a request without traceparent starts a new trace; a job without one starts a root span", async () => {
    const api = initTelemetry("api", { memory: true });
    await api.serve(() => new Response("ok"))(new Request("http://127.0.0.1/health"));
    const s = api.finished()[0]!;
    expect(s.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(s.parentSpanContext).toBeUndefined();
    await api.fromJob({}, "orphan", () => undefined);
    expect(api.finished()[1]!.parentSpanContext).toBeUndefined();
    await api.shutdown();
  });

  test("span file: one JSON line per span with redacted attributes", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/capstan-tel-${process.pid}-${Date.now()}`;
    const file = `${dir}/spans.jsonl`;
    const t = initTelemetry("relay", { otlpFile: file });
    await t.span("x", (s) => void s.setAttribute("signature", "ab".repeat(65)));
    const lines = (await Bun.file(file).text()).trim().split("\n");
    expect(lines.length).toBe(1);
    const j = JSON.parse(lines[0]!);
    expect(j.name).toBe("x");
    expect(j.resource["service.name"]).toBe("relay");
    expect(lines[0]).not.toMatch(/[0-9a-f]{64}/i);
    expect(j.attributes.signature_sha256).toBeString();
    await t.shutdown();
  });
});
