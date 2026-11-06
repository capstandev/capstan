// Metrics wiring (todo 37): the ws gateway reports open connections (capstan_ws_connections) and counts requests.
import { metricsHandler, metricValue } from "@capstan/telemetry";
import { describe, expect, test } from "bun:test";
import { client, startWs } from "./helpers";

const scrape = async () => (await metricsHandler()(new Request("http://127.0.0.1/metrics")).text());

async function until(f: () => Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("condition not met");
    await Bun.sleep(10);
  }
}

describe("ws metrics", () => {
  test("connections-emitted: the gauge follows opens and closes", async () => {
    const s = await startWs();
    try {
      const a = await client(s.url);
      const b = await client(s.url);
      await until(async () => metricValue(await scrape(), "capstan_ws_connections") === 2);
      a.ws.close();
      await until(async () => metricValue(await scrape(), "capstan_ws_connections") === 1);
      b.ws.close();
      await until(async () => metricValue(await scrape(), "capstan_ws_connections") === 0);
      expect(metricValue(await scrape(), "capstan_http_requests_total", { key: "service", value: "ws" })).toBeGreaterThanOrEqual(2);
    } finally {
      s.stop();
    }
  });
});
