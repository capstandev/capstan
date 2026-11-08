// A stub Capstan API for the site's data tests: the public routes the live views read, with recorded calls.
import type { FundingRowLike, Market, OrderBook, RouteQuote, VenueCapabilities } from "../../src/site/types";
import { SAMPLE_QUOTE } from "../../src/app/samples";

export const NOW = Date.parse("2026-11-08T12:00:00Z");

const market = (id: string, venue: string, asset: string, o: Partial<Market> = {}): Market =>
  ({ id, venue, dex: null, venueSymbol: id.split(":").pop(), marketType: "perp", canonicalAsset: asset, collateralAsset: "USDC", tickSize: "0.1", lotSize: "0.001", minNotional: null, maxLeverage: 40, marginModes: ["cross"], fundingIntervalS: 3600, fundingSettleIntervalS: 3600, sessionHours: null, oiCapUsd: null, builderFeeUnit: null, executable: true, ...o }) as unknown as Market;

export const MARKETS: Market[] = [
  market("hyperliquid:-:BTC", "hyperliquid", "CR:BTC"),
  market("lighter-mainnet:-:BTC", "lighter-mainnet", "CR:BTC"),
  market("variational:-:BTC", "variational", "CR:BTC", { executable: false }),
  market("hyperliquid:-:ETH", "hyperliquid", "CR:ETH"),
  market("hyperliquid:-:SOL", "hyperliquid", "CR:SOL"),
  market("hyperliquid:xyz:TSLA", "hyperliquid", "EQ:TSLA", { dex: "xyz" }),
  market("lighter-rh:-:USDG", "lighter-rh", "CR:USDG", { marketType: "spot" }),
];

export const VENUES = [
  { venue: "hyperliquid", execution: true, builderFee: { kind: "hl_builder_code", unit: "tenths_bp", capBps: 10, chargeBps: 2 } },
  { venue: "lighter-mainnet", execution: true, builderFee: { kind: "lighter_integrator", unit: "ppm", capBps: 10, chargeBps: 0 } },
  { venue: "aster", execution: true, builderFee: { kind: "aster_code", unit: "decimal_rate", capBps: 10, chargeBps: 2 } },
  { venue: "variational", execution: false, builderFee: null },
] as unknown as VenueCapabilities[];

export const book = (id: string): OrderBook => ({ marketId: id, bids: [["100000", "1.5"], ["99990", "2"]], asks: [["100010", "1"], ["100020", "3"]], asOf: "2026-11-08T11:59:50Z" });

export const fundingRows = (asset: string): FundingRowLike[] =>
  MARKETS.filter((m) => m.canonicalAsset === asset).map((m, i) => ({ marketId: m.id, venue: m.venue, executable: m.executable, status: i === 2 ? "unavailable" : "ok", source: "venue", asOf: "2026-11-08T11:59:00Z", ratePerInterval: i === 2 ? null : "0.0000125", intervalS: 3600, ratePerHour: "0.0000125", rateAnnualised: i === 2 ? null : String(0.1095 * (i + 1)), nextSettlementAt: "2026-11-08T13:00:00Z" }));

export interface Stub {
  fetch: typeof fetch;
  calls: string[];
  mode: "ok" | "empty" | "down" | "error";
}

export function stubApi(base = "http://api.test/v1"): Stub {
  const s: Stub = {
    calls: [],
    mode: "ok",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const path = url.pathname.replace(/^\/v1/, "");
      s.calls.push(`${init?.method ?? "GET"} ${path}${url.search}`);
      if (s.mode === "down") throw new TypeError("fetch failed");
      if (s.mode === "error") return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "the database is down" } }), { status: 503 });
      const empty = s.mode === "empty";
      const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
      if (path === "/markets") return json({ markets: empty ? [] : MARKETS });
      if (path === "/venues") return json(empty ? [] : VENUES);
      if (path === "/health") return json({ ok: true, service: "api" });
      if (path === "/funding") return json({ asset: url.searchParams.get("asset"), rows: empty ? [] : fundingRows(url.searchParams.get("asset") ?? "") });
      const b = /^\/markets\/([^/]+)\/book$/.exec(path);
      if (b) return json(empty ? { marketId: decodeURIComponent(b[1]!), bids: [], asks: [], asOf: "2026-11-08T11:59:50Z" } : book(decodeURIComponent(b[1]!)));
      if (path === "/quote" && init?.method === "POST") return json(empty ? { ...SAMPLE_QUOTE, legs: [] } : (SAMPLE_QUOTE as RouteQuote));
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no route" } }), { status: 404 });
    }) as typeof fetch,
  };
  void base;
  return s;
}
