// Metrics wiring (todo 37): every MCP tool call moves capstan_mcp_tool_calls_total for that tool, and the served
// fetch (tel.serve, as in the entry point) counts HTTP requests and makes one SERVER span per request.
import { initTelemetry, metricsHandler, metricValue } from "@capstan/telemetry";
import { describe, expect, test } from "bun:test";
import { localApi, MCP_HOST, mcp } from "./helpers";

const scrape = async () => (await metricsHandler()(new Request("http://127.0.0.1/metrics")).text());

describe("mcp metrics", () => {
  test("tool-call-emitted: a tools/call is counted per tool and served under a span", async () => {
    const { api } = await localApi();
    const tel = initTelemetry("mcp", { memory: true });
    const app = mcp(api);
    const fetch = tel.serve((req) => app.fetch(req));
    const tool = { key: "tool", value: "capstan_markets" };
    const before = metricValue(await scrape(), "capstan_mcp_tool_calls_total", tool) ?? 0;
    const http0 = metricValue(await scrape(), "capstan_http_requests_total", { key: "service", value: "mcp" }) ?? 0;
    const res = await fetch(new Request(`http://${MCP_HOST}/mcp`, { method: "POST", headers: { host: MCP_HOST, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "capstan_markets", arguments: {} } }) }));
    expect(res.status).toBe(200);
    const text = await scrape();
    expect(metricValue(text, "capstan_mcp_tool_calls_total", tool)).toBe(before + 1);
    expect(metricValue(text, "capstan_http_requests_total", { key: "service", value: "mcp" })).toBe(http0 + 1);
    expect(tel.finished().some((s) => s.name === "POST /mcp")).toBe(true);
    await tel.shutdown();
  });
});
