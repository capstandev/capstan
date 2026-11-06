// R9, R15 (todo 29): every failure path answers { error: { code, message, receiptId? } } with the 01 status table, and
// every 403 refusal (eligibility edge, MARKET_NOT_EXECUTABLE, VENUE_DATA_ONLY, BUILDER_APPROVAL_REQUIRED,
// FEE_FREE_UNAVAILABLE, POLICY_BREACH at build) carries the id of a signed refusal receipt.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, schema, type Db, type RouteSpec } from "@capstan/core";
import { edgeFor, staticGeo } from "@capstan/eligibility";
import { inProcessRelayClient, handleClaim, pgRelayStore } from "@capstan/relay";
import { STANDARD_FEE } from "@capstan/plans";
import { CapstanError, ERROR_CODES, type ErrorCode } from "@capstan/schema";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT, HL_REF, NOW, policyFor, relayStack, USER_A } from "../../relay/test/helpers";
import { createApp } from "../src/app";
import type { BuildAdapter } from "../src/adapters";
import { apiKeyCheck, apiKeyVerifier, ownerSigVerifier } from "../src/auth";
import { memoryWindowStore, rateLimiter } from "../src/ratelimit";
import { createOnboardingRoutes } from "../src/routes/onboarding.routes";
import { createOrderRoutes, type OrdersRouteDeps } from "../src/routes/orders.routes";
import { HOST, memoryNonceStore } from "./gw-helpers";

const PG = process.env.DATABASE_URL;

function expectShape(body: unknown, status: number): ErrorCode {
  const b = body as { error?: { code?: string; message?: string; receiptId?: string } };
  expect(Object.keys(b)).toEqual(["error"]);
  expect(typeof b.error!.code).toBe("string");
  expect(typeof b.error!.message).toBe("string");
  for (const k of Object.keys(b.error!)) expect(["code", "message", "receiptId"]).toContain(k);
  const code = b.error!.code as ErrorCode;
  expect(ERROR_CODES[code], code).toBeDefined();
  expect(ERROR_CODES[code].status as number, code).toBe(status);
  return code;
}

describe("errors", () => {
  test("shape", async () => {
    const limiter = rateLimiter({ store: memoryWindowStore(), ipOf: () => "198.51.100.77", multiplier: async () => 1, limits: { read: 3 } });
    const verifiers = { owner_sig: ownerSigVerifier({ nonces: memoryNonceStore(), host: HOST, agentsOf: async () => [] }), api_key: apiKeyVerifier(apiKeyCheck({ verify: async () => null })) };
    const { app } = await createApp({ verifiers, limiter, edge: () => async (_c, next) => next() });
    const seen = new Set<number>();
    const check = async (r: Response) => {
      seen.add(r.status);
      return expectShape(await r.json(), r.status);
    };
    expect(await check(await app.request("/v1/no-such-route"))).toBe("NOT_FOUND");
    expect(await check(await app.request(`/v1/receipts?owner=${USER_A}`))).toBe("UNAUTHORIZED");
    expect(await check(await app.request("/v1/credits", { headers: { authorization: "Bearer cpst_nope" } }))).toBe("UNAUTHORIZED");
    expect(await check(await app.request("/v1/orders/build", { method: "POST", body: "{}", headers: { "content-type": "application/json", authorization: "Bearer x" } }))).toBe("UNAUTHORIZED");
    expect(await check(await app.request("/v1/markets?venue=nope"))).toBe("INVALID_INPUT");
    expect(await check(await app.request("/v1/markets/x/book?depth=1000"))).toBe("INVALID_INPUT");
    // a burst: 429 with the same shape
    let last: Response | null = null;
    for (let i = 0; i < 6; i++) last = await app.request("/v1/onboarding/preflight?venue=nope");
    expect(await check(last!)).toBe("VENUE_RATE_LIMITED");
    // priced routes with payments off (no payment middleware wired): never free, 503 or 402 in the error shape
    const { app: paid } = await createApp({ verifiers: { x402: () => null }, payment: async (c) => c.json({ error: { code: "X402_PAYMENTS_UNAVAILABLE", message: "payments unavailable" } }, 503), edge: () => async (_c, next) => next() });
    expect(await check(await paid.request("/v1/funding/forecast?asset=CR:BTC"))).toBe("X402_PAYMENTS_UNAVAILABLE");
    expect([...seen].sort()).toEqual([400, 401, 404, 429, 503]);
    // a thrown CapstanError and an unexpected throw both keep the shape
    const boom: RouteSpec[] = [
      { method: "GET", path: "/capstan-error", auth: "public", handler: () => { throw new CapstanError("STALE_QUOTE"); } },
      { method: "GET", path: "/crash", auth: "public", handler: () => { throw new Error("db password=hunter2 leaked?"); } },
    ];
    const { app: b } = await createApp({ routesDir: mkdtempSync(join(tmpdir(), "capstan-err-")), extraRoutes: boom });
    expect(await check(await b.request("/v1/capstan-error"))).toBe("STALE_QUOTE");
    const crash = await b.request("/v1/crash");
    const cb = await crash.json();
    expect(expectShape(cb, crash.status)).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(cb)).not.toContain("hunter2"); // internal messages never leak
  });

  const d = PG ? test : test.skip;
  let tmp: Awaited<ReturnType<typeof createTempDatabase>> | null = null;
  let db: Db | null = null;
  beforeAll(async () => {
    if (!PG) return;
    tmp = await createTempDatabase(PG, { migrated: true, prefix: "capstan_errors" });
    db = createDb(tmp.url, { max: 4 });
  }, 60_000);
  afterAll(async () => {
    if (db) await closeDb(db);
    await tmp?.drop();
  }, 60_000);

  d("refusal-receipted", async () => {
    const s = relayStack();
    try {
      const pg = pgRelayStore(db!);
      s.deps.store = pg;
      await db!.insert(schema.delegations).values([
        { id: HL_REF, venue: "hyperliquid", owner: USER_A, agentAddress: AGENT, builderMaxBps: 3, state: "active" },
        { id: "hl:pol", venue: "hyperliquid", owner: USER_A, agentAddress: "0x00000000000000000000000000000000000000e1", builderMaxBps: 3, state: "active" },
        { id: "aster:refuse", venue: "aster", owner: USER_A, agentAddress: "0x00000000000000000000000000000000000000e2", state: "active" },
        { id: "arcus:data", venue: "arcus", owner: USER_A, agentAddress: "0x00000000000000000000000000000000000000e3", state: "active" },
      ]);
      s.policies.set("hl:pol", { policyId: "pol-err", policy: policyFor("hl:pol", { maxNotionalPerOrderUsd: "1" }) });
      let refuse: ErrorCode = "BUILDER_APPROVAL_REQUIRED";
      const asterStub = { caps: { venue: "aster", execution: true }, buildOrder: async () => { throw new CapstanError(refuse); } } as unknown as BuildAdapter;
      const dataOnly = { caps: { venue: "arcus", execution: false } } as unknown as BuildAdapter;
      const deps: OrdersRouteDeps = {
        db: db!,
        adapters: new Map([["hyperliquid", s.builder.adapter as unknown as BuildAdapter], ["aster", asterStub], ["arcus", dataOnly]]),
        relay: inProcessRelayClient(s.deps),
        claim: (r) => handleClaim(r, s.deps),
        policy: s.deps.policy,
        usage: pg.agentUsage,
        issue: async (dr) => ({ receiptId: (await s.receipts.issue(dr)).receiptId }),
        alerts: s.deps.alerts,
        feeOf: async () => STANDARD_FEE,
        laneOf: async () => "pro",
        isExecutable: async (m) => m !== "hyperliquid:-:ETH",
        now: () => NOW,
      };
      const ips: Record<string, string> = { "203.0.113.1": "DE", "203.0.113.2": "US" };
      let ip = "203.0.113.1";
      const edge = edgeFor({ geo: staticGeo(ips), db: db!, now: () => new Date(NOW), issue: (dr) => s.receipts.issue(dr), ipOf: () => ip });
      const routes: RouteSpec[] = [...createOrderRoutes(() => deps), ...createOnboardingRoutes(() => ({ db: db!, adapters: deps.adapters, issue: deps.issue, now: () => NOW }))];
      const { app: edged } = await createApp({ routesDir: mkdtempSync(join(tmpdir(), "capstan-ref-")), extraRoutes: routes, verifiers: { owner_sig: () => null, api_key: () => null }, edge });
      // past the edge (an allowed decision), for the build-time refusals
      const { app } = await createApp({ routesDir: mkdtempSync(join(tmpdir(), "capstan-ref2-")), extraRoutes: routes, verifiers: { owner_sig: () => null, api_key: () => null }, edge: () => async (c, next) => { (c as unknown as { set(k: string, v: unknown): void }).set("eligibilityDecisionId", "elig-allowed"); await next(); } });
      const intent = (marketId = "hyperliquid:-:BTC") => ({ marketId, side: "buy", size: "0.001", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 });
      const post = (path: string, body: unknown, a = app) => a.request(`/v1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const refusal = async (r: Response, code: ErrorCode) => {
        expect(r.status).toBe(403);
        const b = (await r.json()) as { error: { code: string; receiptId?: string } };
        expect(expectShape(b, 403)).toBe(code);
        expect(b.error.receiptId, code).toBeDefined();
        expect(s.receipts.byId(b.error.receiptId!)!.action).toBe("refusal");
      };
      // the eligibility edge (a refused country): declared region rules come from the todo 23 tables
      ip = "203.0.113.2";
      const geo = await post("/orders/build", { owner: USER_A, agentRef: HL_REF, intent: intent("hyperliquid:xyz:TSLA"), mode: "relay" }, edged);
      expect(geo.status).toBe(403);
      const gb = (await geo.json()) as { error: { code: string; receiptId?: string } };
      expect(["GEO_REFUSED", "DECLARATION_MISSING"]).toContain(gb.error.code);
      expect(s.receipts.byId(gb.error.receiptId!)!.action).toBe("refusal");
      ip = "203.0.113.1";
      // the build refusals (crypto markets need no declaration in the default rules)
      await refusal(await post("/orders/build", { owner: USER_A, agentRef: HL_REF, intent: intent("hyperliquid:-:ETH"), mode: "relay" }), "MARKET_NOT_EXECUTABLE");
      await refusal(await post("/orders/build", { owner: USER_A, agentRef: "arcus:data", intent: intent("arcus:-:BTC"), mode: "relay" }), "VENUE_DATA_ONLY");
      await refusal(await post("/orders/build", { owner: USER_A, agentRef: "aster:refuse", intent: intent("aster:-:BTCUSDT"), mode: "relay" }), "BUILDER_APPROVAL_REQUIRED");
      refuse = "FEE_FREE_UNAVAILABLE";
      const ff = await post("/orders/build", { owner: USER_A, agentRef: "aster:refuse", intent: intent("aster:-:BTCUSDT"), mode: "relay" });
      // FEE_FREE_UNAVAILABLE is a 409 in the status table; it still carries its refusal receipt
      const fb = (await ff.json()) as { error: { code: string; receiptId?: string } };
      expect(expectShape(fb, ff.status)).toBe("FEE_FREE_UNAVAILABLE");
      expect(s.receipts.byId(fb.error.receiptId!)!.action).toBe("refusal");
      await refusal(await post("/orders/build", { owner: USER_A, agentRef: "hl:pol", intent: intent(), mode: "relay" }), "POLICY_BREACH");
      await refusal(await post("/onboarding/build", { venue: "arcus", owner: USER_A, agentAddress: AGENT }), "VENUE_DATA_ONLY");
    } finally {
      s.stop();
    }
  }, 60_000);
});
