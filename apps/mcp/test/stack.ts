// The agent end-to-end stack: Postgres (a throwaway database), Redis when REDIS_URL is set, the real API routes
// (quote, orders, receipts, agents, eligibility), the real relay pipeline in process with fake Hyperliquid, Lighter
// and Aster venues, a Hyperliquid adapter that builds HIP-3 (xyz:TSLA) orders on recorded fixtures, and the MCP app with
// every tool. A spy records every inbound MCP request body. The owner signs an eligibility declaration first.
import { createAdapter as createHlAdapter, createHip3Gate, createHip3Hook } from "@capstan/adapter-hyperliquid";
import { createRedis, createTempDatabase, createDb, closeDb, devSigner, memoryNonceStore, schema, ulid, type Db, type MarketDataCache, type Redis, type RouteSpec } from "@capstan/core";
import { declarationList, declarationTypedData, edgeFor, staticGeo, storeDeclaration } from "@capstan/eligibility";
import { redisKillSwitch, type KillAdapter } from "@capstan/policy";
import { STANDARD_FEE } from "@capstan/plans";
import { memoryCatalog, type QuoteAdapter, type QuoteMarket } from "@capstan/quote";
import { createReceiptService, type ReceiptService } from "@capstan/receipts";
import { handleClaim, inProcessRelayClient, memoryKillView, pgRelayStore, redisKillView } from "@capstan/relay";
import type { FundingSnapshot, Hex, OrderBook, VenueId } from "@capstan/schema";
import { hashTypedData } from "viem";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../api/src/app";
import type { BuildAdapter } from "../../api/src/adapters";
import { apiKeyCheck, apiKeyVerifier, ownerSigVerifier, x402Verifier } from "../../api/src/auth";
import { createAgentRoutes } from "../../api/src/routes/agents.routes";
import { createEligibilityRoutes } from "../../api/src/routes/eligibility.routes";
import { createOrderRoutes, type OrdersRouteDeps } from "../../api/src/routes/orders.routes";
import { createQuoteRoutes } from "../../api/src/routes/quote.routes";
import { createClaimRoutes } from "../../api/src/routes/receipts-claim.routes";
import { createReceiptRoutes, dbReceiptDeps } from "../../api/src/routes/receipts.routes";
import { BUILDER, CFG, fx, hasFx } from "../../../packages/adapters/hyperliquid/test/helpers";
import { book, setup, T0 } from "../../../packages/adapters/hyperliquid/test/orders/util";
import { addressOfSecret, signDigestRsv } from "../../../packages/sdk/src/keys/secp";
import { NOW, relayStack } from "../../relay/test/helpers";
import { httpApiClient } from "../src/client";
import { createMcpApp, type McpAppDeps } from "../src/server";
import { mcpKey } from "./helpers";

export const API_HOST = "api.capstan.test";
export const MCP_HOST = "mcp.capstan.test";
export const AGENT_IP = "203.0.113.9";
export const REFUSED_IP = "198.51.100.66";
export const API_KEY = "cpst_e2e_agent_host_key";
export const TSLA = "hyperliquid:xyz:TSLA";
export const RH_TSLA = "lighter-rh:-:TSLA";

export interface StackOptions {
  db?: Db;
  readRoot?: (hourEpoch: number) => Promise<Hex | null>;
  mcp?: Partial<McpAppDeps>;
}

const iso = (ms: number) => new Date(ms).toISOString();
const market = (id: string, venue: VenueId, dex: string | null, sym: string, collateral: string): QuoteMarket => ({
  id,
  venue,
  dex,
  venueSymbol: dex ? `${dex}:${sym}` : sym,
  marketType: "perp",
  canonicalAsset: "EQ:TSLA",
  collateralAsset: collateral,
  tickSize: "0.01",
  lotSize: "0.001",
  minNotional: null,
  maxLeverage: 10,
  marginModes: ["isolated"],
  fundingIntervalS: 3600,
  fundingSettleIntervalS: 3600,
  sessionHours: null,
  oiCapUsd: null,
  builderFeeUnit: venue === "hyperliquid" ? "tenths_bp" : "ppm",
  status: "active",
  executable: true,
  dataFreshness: "live",
  updatedAt: iso(NOW),
});

export async function e2eStack(o: StackOptions = {}) {
  const tmp = o.db ? null : await createTempDatabase(process.env.DATABASE_URL!, { migrated: true, prefix: "capstan_mcp_e2e" });
  const db = o.db ?? createDb(tmp!.url, { max: 6 });
  const redis: Redis | null = process.env.REDIS_URL ? createRedis(process.env.REDIS_URL) : null;

  // owner (main wallet, test label) and its signed eligibility declaration
  const ownerKey = mcpKey(`e2e-owner-${ulid()}`);
  const owner = addressOfSecret(ownerKey).toLowerCase() as Hex;
  const td = declarationTypedData(owner, ["hyperliquid", "lighter-rh"], declarationList(["hyperliquid", "lighter-rh"]), Math.floor(NOW / 1000) - 60);
  await storeDeclaration(td, signDigestRsv(hashTypedData(td as never), ownerKey), db, NOW);

  // relay in process (fake venues), on this database
  const s = relayStack();
  s.deps.store = pgRelayStore(db);
  const receiptSigner = devSigner(31337, "capstan-mcp-e2e-receipts");
  const receipts: ReceiptService = createReceiptService({ db, signer: receiptSigner, now: () => new Date(NOW) });
  s.deps.receipts = { issue: (d) => receipts.issue(d) };
  const killView = redis ? redisKillView(redis) : memoryKillView();
  if (redis) await (killView as ReturnType<typeof redisKillView>).ready;
  s.deps.kill = killView;
  s.deps.policy = { active: async (ref, ow) => (await import("@capstan/policy")).activePolicyFor(db, ref, ow).then((p) => (p && !p.revoked ? { policyId: p.policyId, policy: p.policy } : null)) };
  s.deps.lanes = { take: async (x) => ({ ok: true, lane: x.lane }) };

  // a Hyperliquid adapter that builds core and HIP-3 orders on recorded fixtures (any owner reads userA's xyz account)
  const hl = setup((b) => {
    if (b.type === "clearinghouseState") {
      if (!b.dex) return fx("clearinghouseState_userA");
      return hasFx(`clearinghouseState_userA_${b.dex}`) ? fx(`clearinghouseState_userA_${b.dex}`) : undefined;
    }
    if (b.type === "maxBuilderFee") return 30;
    return undefined;
  });
  const hip3 = createHip3Hook({ reader: hl.reader, gate: createHip3Gate({}), isExecutable: () => true, eqExecutionAllowed: () => true });
  const hlBuilder = createHlAdapter({ ...CFG, builderAddress: BUILDER }, { http: hl.http, cache: hl.cache, reader: hl.reader, now: () => T0, enabled: () => true, hip3, agentState: () => "active" });
  const tslaBook: OrderBook = book(TSLA, 347.6, T0, 10, 0.05, "50.0");
  await hl.cache.putBook(tslaBook);

  // quote: HL xyz:TSLA and a Lighter-RH TSLA market, fixture books
  const rhBook: OrderBook = { marketId: RH_TSLA, bids: [["347.40", "20"], ["347.30", "20"]], asks: [["347.80", "20"], ["347.90", "20"]], asOf: iso(NOW - 200) };
  const books: Record<string, OrderBook> = { [TSLA]: { ...tslaBook, asOf: iso(NOW - 100) }, [RH_TSLA]: rhBook };
  const funding = (marketId: string): FundingSnapshot => ({ marketId, ratePerInterval: "0.00001", intervalS: 3600, ratePerHour: "0.00001", rateAnnualised: "0.0876", predictedNext: null, nextSettlementAt: iso(NOW + 600_000), capPerHour: "0.04", source: "venue", asOf: iso(NOW - 1000) });
  const cache = { getBook: async (id: string) => books[id] ?? null, getFunding: async (id: string) => (books[id] ? funding(id) : null), getMark: async () => null } as unknown as MarketDataCache;
  const capsOf = (venue: VenueId) => ({ venue, execution: true, keyType: "secp256k1" as const, delegation: "agent" as const, canWithdraw: false as const, builderFee: null, collateral: ["USDC"], directSubmitSupported: true, publicAccountReads: true });
  const quoteAdapter = (venue: VenueId): QuoteAdapter => ({ caps: capsOf(venue), getBook: async (id: string) => books[id]!, getFunding: async (id: string) => funding(id) });
  const quote = createQuoteRoutes(() => ({ adapters: new Map<VenueId, QuoteAdapter>([["hyperliquid", quoteAdapter("hyperliquid")], ["lighter-rh", quoteAdapter("lighter-rh")]]), cache, catalog: memoryCatalog([market(TSLA, "hyperliquid", "xyz", "TSLA", "USDC"), market(RH_TSLA, "lighter-rh", null, "TSLA", "USDG")]), depeg: { usdgUsdcBps: async () => null, usdtUsdcBps: async () => null }, store: null, now: () => NOW }));

  const issue = async (d: Parameters<ReceiptService["issue"]>[0]) => ({ receiptId: (await receipts.issue(d)).receiptId });
  const ordersDeps: OrdersRouteDeps = {
    db,
    adapters: new Map([["hyperliquid", hlBuilder as unknown as BuildAdapter]]),
    relay: inProcessRelayClient(s.deps),
    claim: (r) => handleClaim(r, s.deps),
    policy: s.deps.policy,
    usage: s.deps.store.agentUsage,
    issue,
    alerts: s.deps.alerts,
    feeOf: async () => STANDARD_FEE,
    laneOf: async () => "pro",
    isExecutable: async () => true,
    ipOf: () => AGENT_IP,
    now: () => NOW,
  };
  const killSwitch = redis ? redisKillSwitch(redis, db, { now: () => new Date(NOW) }) : null;
  const agents = killSwitch ? createAgentRoutes(() => ({ db, killSwitch, nonces: memoryNonceStore(), receipts: { issue }, adapters: new Map<VenueId, KillAdapter>([["hyperliquid", hlBuilder as unknown as KillAdapter]]), host: API_HOST, now: () => NOW })) : [];
  const geo = staticGeo({ [AGENT_IP]: "DE", [REFUSED_IP]: "US" });
  const eligibility = createEligibilityRoutes(() => ({ db, geo, now: () => new Date(NOW), ipOf: (c) => c.req.header("x-forwarded-for") ?? null }));
  const routes: RouteSpec[] = [...quote, ...createOrderRoutes(() => ordersDeps), ...createClaimRoutes(() => ordersDeps), ...createReceiptRoutes(() => ({ ...dbReceiptDeps(db, { signers: [receiptSigner.address], readRoot: o.readRoot ?? (async () => null) }), now: () => NOW })), ...agents, ...eligibility];
  // the agent host's key was made for the owner's wallet (an api_key acts only for its own wallet, r1 R1-04)
  const check = apiKeyCheck({ verify: async (k) => (k === API_KEY ? { id: "acct-e2e", ownerWallet: owner, tier: "pro" } : null) });
  const { app: api } = await createApp({
    routesDir: mkdtempSync(join(tmpdir(), "capstan-e2e-routes-")),
    extraRoutes: routes,
    verifiers: { owner_sig: ownerSigVerifier({ nonces: memoryNonceStore(), host: API_HOST, now: () => NOW, agentsOf: async () => [] }), api_key: apiKeyVerifier(check), x402: x402Verifier({ check, spend: async () => false, internalToken: "internal-token-for-the-e2e-mcp-host-000" }) },
    edge: edgeFor({ geo, db, now: () => new Date(NOW), issue: (d) => receipts.issue(d), ipOf: () => AGENT_IP }),
  });
  const apiCalls: { method: string; path: string; body: string }[] = [];
  const apiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    apiCalls.push({ method: req.method, path: `${u.pathname}${u.search}`, body: req.method === "GET" ? "" : await req.clone().text() });
    return api.fetch(req);
  }) as typeof fetch;

  const mcpApp = createMcpApp({ api: httpApiClient(`http://${API_HOST}/v1`, apiFetch), version: "e2e", allowedHosts: [MCP_HOST], allowedOrigins: [], clientIpOf: () => AGENT_IP, ...(o.mcp ?? {}) });
  const inbound: string[] = [];
  /** fetch into the MCP app, recording every inbound request body (the no-key spy). */
  const mcpFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    inbound.push(req.method === "POST" ? await req.clone().text() : "");
    const headers = new Headers(req.headers);
    headers.set("host", MCP_HOST);
    return mcpApp.fetch(new Request(req, { headers }));
  }) as typeof fetch;

  return {
    db,
    redis,
    owner,
    ownerKey,
    relay: s,
    receipts,
    receiptSigner: receiptSigner.address as Hex,
    api,
    apiCalls,
    mcpApp,
    mcpFetch,
    mcpUrl: `http://${MCP_HOST}/mcp`,
    inbound,
    hlBuilder,
    /** Insert an active delegation (the onboarding result) for an agent address. */
    async delegate(agentAddress: Hex, venue: VenueId = "hyperliquid") {
      const id = `hl:${agentAddress.toLowerCase()}`;
      await db.insert(schema.delegations).values({ id, venue, owner, agentAddress: agentAddress.toLowerCase(), builderMaxBps: 3, state: "active", createdAt: new Date(NOW) });
      return id;
    },
    async stop() {
      s.stop();
      await killSwitch?.close?.();
      if (redis) await (killView as ReturnType<typeof redisKillView>).close();
      await redis?.quit().catch(() => undefined);
      if (!o.db) {
        await closeDb(db);
        await tmp!.drop();
      }
    },
  };
}
