// Metrics and tracing wiring (todo 37): a quote records the age of every priced leg's book per venue, and the
// served fetch (tel.serve, as in the entry point) counts the request and makes one SERVER span that continues the
// caller's traceparent.
import type { MarketDataCache } from "@capstan/core";
import { memoryCatalog, type QuoteAdapter, type QuoteMarket } from "@capstan/quote";
import type { FundingSnapshot, OrderBook, VenueId } from "@capstan/schema";
import { initTelemetry, metricsHandler, metricValue, SpanKind } from "@capstan/telemetry";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createQuoteRoutes, type QuoteRouteDeps } from "../src/routes/quote.routes";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ETH: QuoteMarket = { id: "hyperliquid:-:ETH", venue: "hyperliquid", dex: null, venueSymbol: "ETH", marketType: "perp", canonicalAsset: "CR:ETH", collateralAsset: "USDC", tickSize: "0.1", lotSize: "0.0001", minNotional: null, maxLeverage: 25, marginModes: ["cross", "isolated"], fundingIntervalS: 28800, fundingSettleIntervalS: 3600, sessionHours: null, oiCapUsd: null, builderFeeUnit: "tenths_bp", status: "active", executable: true, dataFreshness: "live", updatedAt: iso(NOW) };
const BOOK: OrderBook = { marketId: ETH.id, bids: [["1999.5", "10"]], asks: [["2000.5", "10"]], asOf: iso(NOW - 700) };
const FUND: FundingSnapshot = { marketId: ETH.id, ratePerInterval: "0.00001", intervalS: 3600, ratePerHour: "0.00001", rateAnnualised: "0.0876", predictedNext: null, nextSettlementAt: iso(NOW), capPerHour: "0.04", source: "venue", asOf: iso(NOW - 1000) };
const scrape = async () => (await metricsHandler()(new Request("http://127.0.0.1/metrics")).text());

describe("api metrics", () => {
  test("quote-staleness-emitted: a quote observes the leg's book age and the request is served under a span", async () => {
    const cache = { getBook: async () => BOOK, getFunding: async () => FUND, getMark: async () => null } as unknown as MarketDataCache;
    const hl: QuoteAdapter = { caps: { venue: "hyperliquid", execution: true, keyType: "secp256k1", delegation: "agent", canWithdraw: false, builderFee: null, collateral: ["USDC"], directSubmitSupported: true, publicAccountReads: true }, getBook: async () => BOOK, getFunding: async () => FUND };
    const deps: QuoteRouteDeps = { adapters: new Map<VenueId, QuoteAdapter>([["hyperliquid", hl]]), cache, catalog: memoryCatalog([ETH]), depeg: { usdgUsdcBps: async () => null, usdtUsdcBps: async () => null }, store: null, now: () => NOW };
    const h = new Hono();
    for (const r of createQuoteRoutes(() => deps)) h.on(r.method, `/v1${r.path}`, (c) => r.handler(c));
    const tel = initTelemetry("api", { memory: true });
    const fetch = tel.serve((req) => h.fetch(req));
    const venue = { key: "venue", value: "hyperliquid" };
    const t0 = await scrape();
    const count0 = metricValue(t0, "capstan_quote_staleness_ms_count", venue) ?? 0;
    const sum0 = metricValue(t0, "capstan_quote_staleness_ms_sum", venue) ?? 0;
    const http0 = metricValue(t0, "capstan_http_requests_total", { key: "service", value: "api" }) ?? 0;
    const parent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const res = await fetch(new Request("http://127.0.0.1/v1/quote", { method: "POST", headers: { "content-type": "application/json", traceparent: parent }, body: JSON.stringify({ canonicalAsset: "CR:ETH", side: "buy", sizeBase: "1", leverage: 5, holdHours: 2, orderType: "market" }) }));
    expect(res.status).toBe(200);
    const t1 = await scrape();
    expect(metricValue(t1, "capstan_quote_staleness_ms_count", venue)).toBe(count0 + 1);
    expect(metricValue(t1, "capstan_quote_staleness_ms_sum", venue)).toBe(sum0 + 700);
    expect(metricValue(t1, "capstan_http_requests_total", { key: "service", value: "api" })).toBe(http0 + 1);
    const span = tel.finished().find((s) => s.name === "POST /v1/quote");
    expect(span?.kind).toBe(SpanKind.SERVER);
    expect(span?.spanContext().traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    await tel.shutdown();
  });
});
