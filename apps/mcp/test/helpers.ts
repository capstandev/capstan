// MCP test helpers: a local API built from the real route factories (markets, quote, positions, risk) on fixture
// data, an MCP app whose API client calls that API in process, and a JSON-RPC caller over Streamable HTTP.
import { capstanMessage, memoryNonceStore, type MarketDataCache, type RouteSpec } from "@capstan/core";
import { memoryCatalog, type QuoteAdapter, type QuoteMarket } from "@capstan/quote";
import { encodeReadMessage, memoryKv, readRequestBody, type AccountAdapter, type CapstanRiskView } from "@capstan/risk";
import type { AccountSnapshot, FundingSnapshot, Hex, Market, OrderBook, VenueId } from "@capstan/schema";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashMessage } from "viem";
import { createApp } from "../../api/src/app";
import { createMarketRoutes } from "../../api/src/routes/markets.routes";
import { createPositionsRoutes } from "../../api/src/routes/positions.routes";
import { createQuoteRoutes } from "../../api/src/routes/quote.routes";
import { createRiskRoutes, type RiskRouteDeps } from "../../api/src/routes/risk.routes";
import { addressOfSecret, signDigestRsv } from "../../../packages/sdk/src/keys/secp";
import { httpApiClient, type CapstanApiClient } from "../src/client";
import { createMcpApp, type McpAppDeps } from "../src/server";

export const API_HOST = "api.capstan.test";
export const MCP_HOST = "mcp.capstan.test";
// in the past on purpose (ULIDs from this clock must not run ahead of the shared ulid order)
export const NOW = Date.parse("2026-05-01T12:00:00Z");
export const mcpKey = (l: string) => keccak_256(utf8ToBytes(`capstan-mcp-test:${l}`)); // test-key
export const OWNER_KEY = mcpKey("owner");
export const OWNER = addressOfSecret(OWNER_KEY).toLowerCase() as Hex;
const iso = (ms: number) => new Date(ms).toISOString();

export const ETH: QuoteMarket = {
  id: "hyperliquid:-:ETH",
  venue: "hyperliquid",
  dex: null,
  venueSymbol: "ETH",
  marketType: "perp",
  canonicalAsset: "CR:ETH",
  collateralAsset: "USDC",
  tickSize: "0.1",
  lotSize: "0.0001",
  minNotional: null,
  maxLeverage: 25,
  marginModes: ["cross", "isolated"],
  fundingIntervalS: 28800,
  fundingSettleIntervalS: 3600,
  sessionHours: null,
  oiCapUsd: null,
  builderFeeUnit: "tenths_bp",
  status: "active",
  executable: true,
  dataFreshness: "live",
  updatedAt: iso(NOW),
};
const BOOK: OrderBook = { marketId: ETH.id, bids: [["1999.5", "10"], ["1999", "10"]], asks: [["2000.5", "10"], ["2001", "10"]], asOf: iso(NOW - 100) };
const FUND: FundingSnapshot = { marketId: ETH.id, ratePerInterval: "0.00001", intervalS: 3600, ratePerHour: "0.00001", rateAnnualised: "0.0876", predictedNext: null, nextSettlementAt: iso(NOW), capPerHour: "0.04", source: "venue", asOf: iso(NOW - 1000) };
const caps = (venue: VenueId) => ({ venue, execution: true, keyType: "secp256k1" as const, delegation: "agent" as const, canWithdraw: false as const, builderFee: null, collateral: ["USDC"], directSubmitSupported: true, publicAccountReads: venue !== "aster" });
const snap = (o: Hex): AccountSnapshot => ({ venue: "hyperliquid", identity: { venue: "hyperliquid", owner: o }, equityUsd: "1000", freeCollateralUsd: "400", positions: [{ venue: "hyperliquid", marketId: ETH.id, canonicalAsset: "CR:ETH", side: "long", size: "1", entryPx: "2000", markPx: "2000", notionalUsd: "2000", leverage: 5, marginMode: "isolated", liqPx: "1700", liqPxSource: "venue", marginRatio: null, unrealisedPnlUsd: "0", collateralAsset: "USDC", asOf: iso(NOW) }], asOf: iso(NOW) });

/** The local API: real route factories on fixture deps, the extra routes a test adds, permissive verifiers. */
export async function localApi(extra: RouteSpec[] = [], o: { verifiers?: Parameters<typeof createApp>[0] extends infer X ? (X extends { verifiers?: infer V } ? V : never) : never; payment?: import("hono").MiddlewareHandler } = {}) {
  const cache = { getBook: async (id: string) => (id === ETH.id ? BOOK : null), getFunding: async (id: string) => (id === ETH.id ? FUND : null), getMark: async () => null } as unknown as MarketDataCache;
  const hl: QuoteAdapter = { caps: caps("hyperliquid"), getBook: async () => BOOK, getFunding: async () => FUND };
  const quote = createQuoteRoutes(() => ({ adapters: new Map<VenueId, QuoteAdapter>([["hyperliquid", hl]]), cache, catalog: memoryCatalog([ETH]), depeg: { usdgUsdcBps: async () => null, usdtUsdcBps: async () => null }, store: null, now: () => NOW }));
  const markets = createMarketRoutes(() => ({ list: async (f) => [ETH as Market].filter((m) => (!f.venue || m.venue === f.venue) && (!f.asset || m.canonicalAsset === f.asset) && (f.executable === undefined || m.executable === f.executable)), book: async () => BOOK }));
  const acct: AccountAdapter = { caps: caps("hyperliquid"), getAccount: async (id) => snap(id.owner) };
  const riskDeps: RiskRouteDeps = {
    identities: async (o) => [{ venue: "hyperliquid", owner: o }],
    accounts: { adapters: new Map([["hyperliquid", acct]]), cache: memoryKv(() => NOW), asterIngested: async () => null },
    catalog: memoryCatalog([ETH]),
    marks: async () => new Map(),
    recentViews: async () => [{ perVenue: [snap(OWNER)] } as Pick<CapstanRiskView, "perVenue">],
    nonces: memoryNonceStore(),
    host: API_HOST,
    now: () => NOW,
  };
  const routes = [...markets, ...quote, ...createRiskRoutes(() => riskDeps), ...createPositionsRoutes(() => riskDeps), ...extra];
  const { app } = await createApp({ routesDir: mkdtempSync(join(tmpdir(), "capstan-mcp-api-")), extraRoutes: routes, verifiers: { owner_sig: () => null, api_key: () => null, x402: () => null, ...(o.verifiers ?? {}) }, ...(o.payment ? { payment: o.payment } : {}), edge: () => async (c, next) => { (c as unknown as { set(k: string, v: unknown): void }).set("eligibilityDecisionId", "elig-mcp"); await next(); } });
  const seen: Request[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(req.clone());
    return app.fetch(req);
  }) as typeof fetch;
  return { app, api: httpApiClient(`http://${API_HOST}/v1`, f), seen };
}

export function mcp(api: CapstanApiClient, over: Partial<McpAppDeps> = {}) {
  return createMcpApp({ api, version: "test", allowedHosts: [MCP_HOST], allowedOrigins: ["https://agent.example"], ...over });
}

let id = 0;
export async function rpc(app: { request(url: string, init: RequestInit): Response | Promise<Response> }, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const r = await app.request(`http://${MCP_HOST}/mcp`, { method: "POST", headers: { host: MCP_HOST, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params !== undefined ? { params } : {}) }) });
  const text = await r.text();
  let body: { result?: any; error?: { code: number; message: string } } = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: r.status, headers: r.headers, body };
}

export const callTool = async (app: Parameters<typeof rpc>[0], name: string, args: unknown, headers: Record<string, string> = {}) => (await rpc(app, "tools/call", { name, arguments: args }, headers)).body.result as { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };

let n = 0;
/** The owner's read signature for an exact GET path (purpose read), as the positions and risk tools need it. */
export function ownerRead(path: string, sk = OWNER_KEY) {
  const owner = addressOfSecret(sk).toLowerCase() as Hex;
  const text = capstanMessage({ purpose: "read", owner, host: API_HOST, chainId: 4663, nonce: `mcp-read-${++n}`, issuedAt: NOW - 1000, expiresAt: NOW + 60_000, body: readRequestBody("GET", path) });
  return { message: encodeReadMessage(text), signature: signDigestRsv(hashMessage(text), sk) };
}
