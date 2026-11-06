// The process-level helpers the services call (traceJobData, traceFromJob, tracedFetch): with telemetry on they
// carry the trace api -> queue -> worker -> venue; with it off they pass data and calls through unchanged.
import { describe, expect, test } from "bun:test";
import { activeTelemetry, initTelemetry, SpanKind, traceFromJob, tracedFetch, traceJobData } from "../src";

describe("wiring helpers", () => {
  test("off: data and calls pass through", async () => {
    // bun runs test files in one process: end a telemetry an earlier file left on
    await activeTelemetry()?.shutdown();
    expect(activeTelemetry()).toBeNull();
    expect(traceJobData({ a: 1 })).toEqual({ a: 1 });
    expect(await traceFromJob({}, "x", () => 7)).toBe(7);
    let seen = "unset" as string | null;
    const f = tracedFetch("hyperliquid", (async (_u: string | URL | Request, init?: RequestInit) => ((seen = new Headers(init?.headers).get("traceparent")), new Response("ok"))) as typeof fetch);
    expect(await (await f("http://venue.test/info")).text()).toBe("ok");
    expect(seen).toBeNull();
  });

  test("on: job data carries the trace, the worker continues it, the venue call sends it", async () => {
    const tel = initTelemetry("api", { memory: true });
    let sent = null as string | null;
    const venue = tracedFetch("hyperliquid", (async (_u: string | URL | Request, init?: RequestInit) => ((sent = new Headers(init?.headers).get("traceparent")), new Response("ok"))) as typeof fetch);
    let traceId = "";
    const data = await tel.span("POST /v1/orders/submit", async (s) => ((traceId = s.spanContext().traceId), traceJobData({ buildId: "b1" })), { kind: SpanKind.SERVER });
    expect(data.traceparent).toContain(traceId);
    await traceFromJob(data, "relay submit", () => venue("http://venue.test/exchange"));
    expect(sent).toContain(traceId);
    const names = tel.finished().map((s) => [s.name, s.spanContext().traceId]);
    expect(names).toContainEqual(["relay submit", traceId]);
    expect(names).toContainEqual(["venue hyperliquid", traceId]);
    await tel.shutdown();
    expect(activeTelemetry()).toBeNull();
  });
});
