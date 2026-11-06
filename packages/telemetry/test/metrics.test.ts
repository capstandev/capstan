import { describe, expect, test } from "bun:test";
import {
  GovernorMonitor,
  initTelemetry,
  METRICS,
  recordBuilderFee,
  recordFunnel,
  recordOnboardingPrompt,
  recordUnhedgedPlans,
  recordUnmatchedFills,
  recordX402SettleFailure,
  resetMetrics,
  StalenessMonitor,
  startMetricsServer,
} from "../src";

describe("metrics", () => {
  test("all-emitted: every METRICS member is emitted by a code path and shows on /metrics", async () => {
    resetMetrics();
    const events: unknown[] = [];
    await new StalenessMonitor((e) => void events.push(e)).observe("hyperliquid", 120, Date.now());
    await new GovernorMonitor((e) => void events.push(e)).observe("egress-a", "aster", 42.5);
    for (const s of ["build", "sign", "submit"] as const) recordFunnel(s);
    for (const s of ["shown", "signed", "declined"] as const) recordOnboardingPrompt(s);
    recordBuilderFee("hyperliquid", "1.25");
    recordUnmatchedFills(3);
    recordUnhedgedPlans(1);
    recordX402SettleFailure("base");
    const venue = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("{}") });
    const tel = initTelemetry("relay", {});
    await tel.venueFetch("lighter-mainnet")(`http://127.0.0.1:${venue.port}/api/v1/sendTx`);
    venue.stop(true);

    const srv = startMetricsServer(0);
    const text = await (await fetch(`http://127.0.0.1:${srv.port}/metrics`)).text();
    srv.stop();
    await tel.shutdown();
    const samples = text.split("\n").filter((l) => l && !l.startsWith("#"));
    for (const m of Object.values(METRICS)) {
      const has = samples.some((l) => l.startsWith(m.name + "{") || l.startsWith(m.name + " ") || l.startsWith(m.name + "_count"));
      if (!has) throw new Error(`metric ${m.name} has no sample on /metrics`);
    }
    expect(text).toContain('capstan_order_funnel_total{stage="submit"} 1');
    expect(text).toContain('capstan_builder_fee_usd_total{venue="hyperliquid"} 1.25');
    expect(text).toContain('capstan_governor_use_pct{budget="egress-a:aster"} 42.5');
    expect(text).toContain('capstan_venue_latency_ms_count{venue="lighter-mainnet"} 1');
    expect(text).toContain("capstan_unmatched_fills 3");
    expect(events).toEqual([]);
  });

  test("histogram buckets are cumulative and counters refuse to go down", () => {
    resetMetrics();
    METRICS.quoteStalenessMs.observe("aster", 7);
    METRICS.quoteStalenessMs.observe("aster", 4000);
    const out = METRICS.quoteStalenessMs.render().join("\n");
    expect(out).toContain('capstan_quote_staleness_ms_bucket{venue="aster",le="10"} 1');
    expect(out).toContain('capstan_quote_staleness_ms_bucket{venue="aster",le="5000"} 2');
    expect(out).toContain('capstan_quote_staleness_ms_bucket{venue="aster",le="+Inf"} 2');
    expect(() => METRICS.funnel.inc("build", -1)).toThrow();
    expect(() => recordBuilderFee("aster", "-1")).toThrow();
  });

  test("/metrics answers 404 on other paths", async () => {
    const srv = startMetricsServer(0);
    expect((await fetch(`http://127.0.0.1:${srv.port}/other`)).status).toBe(404);
    srv.stop();
  });
});
