// The gateway from the environment: verifiers, rate limiter and the x402 payment middleware for createApp. The api
// role's config (loadConfig('api')) holds the ports, Redis, the database and the x402 switch; payTo addresses and the
// public RPCs for the token facts come from X402_PAY_TO_EVM, X402_PAY_TO_SOL, BASE_RPC_URL (BASE_SEPOLIA_RPC_URL on
// testnet), RHC_RPC_URL (mainnet rails and the ETH/USD feed) and RHC_TESTNET_RPC_URL (testnet rails and detection).
// With X402_ENABLED off (the default) every priced route answers 503 "payments unavailable": never served free.
import { createDb, createRedis, logger, redisNonceStore, schema, type ConfigFor, type Db, type RouteSpec } from "@capstan/core";
import { clientIp } from "@capstan/eligibility";
import { LIMITS, limitsFor, multiplierOf, refundCredit, spendCredit, tierOf, topupPendingHook, topupSettleHook, verifyApiKey, lockReaderFromEnv, type LockReader } from "@capstan/plans";
import { errorBody, type Hex } from "@capstan/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { CreateAppOptions } from "../app";
import { memoryWindowStore, preAuthLimiter, rateLimiter, redisWindowStore } from "../ratelimit";
import { apiKeyCheck, apiKeyVerifier, internalVerifier, NONCE_TTL_MS, ownerSigVerifier, x402Verifier } from "./index";

export const agentsOfDb = (db: Db) => async (owner: Hex) => {
  const rows = await db
    .select({ id: schema.delegations.id, agentAddress: schema.delegations.agentAddress })
    .from(schema.delegations)
    .where(and(eq(schema.delegations.owner, owner.toLowerCase()), eq(schema.delegations.state, "active"), isNotNull(schema.delegations.agentAddress)));
  return rows.map((r) => ({ address: r.agentAddress as Hex, agentRef: r.id }));
};

type GateRoute = import("@capstan/x402").PricedRoute;

/**
 * The x402 routes table for the payment middleware, from the mounted specs: `<METHOD> /v1<path>`. A perRows route
 * carries its priceRequest, so the gate charges what the handler delivers (r1 F2); a perRows route without one is
 * refused at boot rather than priced from a query value the handler ignores.
 */
export function pricedRoutes(specs: RouteSpec[]): Record<string, GateRoute> {
  const out: Record<string, GateRoute> = {};
  for (const s of specs) {
    if (s.auth !== "x402" || !s.priced) continue;
    const perRows = (s.priced as { perRows?: 1000 }).perRows;
    const priceRequest = (s as { priceRequest?: GateRoute["priceRequest"] }).priceRequest;
    if (perRows && typeof priceRequest !== "function") throw new Error(`${s.method} ${s.path}: a per-rows priced route needs priceRequest`);
    out[`${s.method} /v1${s.path}`] = { usd: s.priced.usd, description: s.description ?? s.path, ...(perRows ? { perRows: 1000 as const, priceRequest: priceRequest! } : {}) };
  }
  return out;
}

const unavailable: MiddlewareHandler = async (c) => c.json(errorBody("X402_PAYMENTS_UNAVAILABLE", "payments unavailable"), 503);

type X402Mod = typeof import("@capstan/x402");
type EvmClients = Parameters<X402Mod["buildX402State"]>[0]["clients"];
type DetectRpcs = Parameters<X402Mod["runUsdgDetection"]>[1];

/** Test and host seams for the payment wiring; each defaults to the environment. */
export interface PaymentOverrides {
  db?: Db;
  facilitator?: import("@x402/core/server").FacilitatorClient;
  /** Boot clients for token facts, gas and the ETH/USD feed (keyed by CAIP-2 network). */
  clients?: EvmClients;
  /** Read clients for the USDG EIP-3009 detection run at boot (keyed by chain id). */
  detectRpcs?: DetectRpcs;
  log?: { info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void };
  now?: () => number;
}

/**
 * The x402 payment middleware for the api process. With X402_ENABLED and both payTo addresses set it:
 * 1. runs the USDG EIP-3009 detection before serving and writes x402_detections (an unhealthy or unreadable rail is
 *    recorded absent, so the eip3009 option is never offered; the workers job refreshes it every 24 h);
 * 2. registers the credit top-up after-settle hook (topupSettleHook) on the resource server, so a settled
 *    POST /v1/credits/topup/<pack> really adds the credit;
 * 3. serves the gate from railStateLoader: token facts and rail economics read once, detection flags every minute.
 * Anything missing answers 503 "payments unavailable" on priced routes: never served free.
 */
export async function paymentFromEnv(cfg: ConfigFor<"api">, env: Record<string, string | undefined>, specs: RouteSpec[], o: PaymentOverrides = {}): Promise<MiddlewareHandler> {
  if (!cfg.X402_ENABLED) return unavailable;
  const payEvm = env.X402_PAY_TO_EVM as Hex | undefined;
  const paySol = env.X402_PAY_TO_SOL;
  if (!payEvm || !paySol) return unavailable;
  const x = await import("@capstan/x402");
  const net: "mainnet" | "testnet" = cfg.CAPSTAN_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const log = o.log ?? logger("api");
  const db = o.db ?? createDb(cfg.DATABASE_URL, { max: 2 });
  const now = o.now ?? Date.now;
  const fromEnv = o.clients && o.detectRpcs ? null : await x.bootClientsFromEnv(net, env);
  const clients = o.clients ?? fromEnv!.clients;
  const detectRpcs = o.detectRpcs ?? fromEnv!.detectRpcs;
  const alert = (a: { kind: string; [k: string]: unknown }) => log.warn("x402 rail alert", a);
  // 1. detection at boot, before the first request is served (fail closed: an error leaves every eip3009 rail off)
  try {
    const run = await x.runUsdgDetection(db, detectRpcs, now);
    log.info("x402 detection at boot", Object.fromEntries(Object.entries(run.results).map(([c, r]) => [c, { supported: r?.supported, reason: r?.reason }])));
    for (const chain of run.flippedToAbsent) alert({ kind: "x402.eip3009_absent", chain, reason: run.results[chain]?.reason ?? "" });
  } catch (err) {
    alert({ kind: "x402.detection_failed", reason: String((err as Error).message) });
  }
  const routes = pricedRoutes(specs);
  const rails = x.railStateLoader({
    env: net,
    routes,
    clients,
    payTo: { evm: payEvm, sol: paySol },
    detections: () => x.loadUsdgEip3009(db, now()),
    eip3009MainnetEnabled: cfg.X402_USDG_EIP3009_MAINNET,
    alert,
    now,
  });
  const facilitator = o.facilitator ?? new (await import("@x402/core/server")).HTTPFacilitatorClient({ url: cfg.FACILITATOR_URL });
  const rs = x.createResourceServer(facilitator);
  // 2. the credit lands only through this hook (it reads the served path and ?account=, never the client's resource.url)
  rs.onAfterSettle(topupSettleHook(db, { log, decimalsOf: (n, a) => x.decimalsFromState(rails.current(), net)(n, a) }));
  // a settle that came back settlement_pending: record the served account and pack, so the topup-reconcile job
  // credits it once the tx is confirmed (r1 F4)
  rs.onSettleFailure(async (ctx) => void (await topupPendingHook(db, { log, decimalsOf: (n, a) => x.decimalsFromState(rails.current(), net)(n, a) })(ctx)));
  const gate = x.paymentGate(routes, rs, { env: net, state: rails.load });
  return guardedPayment(gate);
}

/** Facilitator down or the rail state unreadable: priced routes answer 503, free routes are not affected. */
export function guardedPayment(gate: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    let served = false;
    try {
      const r = await gate(c, async () => {
        served = true;
        await next();
      });
      // the gate failed before the handler ran (facilitator unreachable at init): never a 500, never served free
      const res = r instanceof Response ? r : c.res;
      if (!served && res.status >= 500) return c.json(errorBody("X402_PAYMENTS_UNAVAILABLE", "payments unavailable"), 503);
      // a 402 keeps the x402 headers (PAYMENT-REQUIRED) and carries the Capstan error body as well (one error shape)
      if (!served && res.status === 402) {
        const headers = new Headers(res.headers);
        headers.set("content-type", "application/json");
        return new Response(JSON.stringify(errorBody("X402_PAYMENT_REQUIRED")), { status: 402, headers });
      }
      return r;
    } catch (e) {
      if (served) throw e;
      return c.json(errorBody("X402_PAYMENTS_UNAVAILABLE", "payments unavailable"), 503);
    }
  };
}

/**
 * The rate limiter's tier multiplier: pro 5x, Lock Whale 5x, Lock Holder 2x, else 1x, cached a minute per subject.
 * Locks come from the shared CPSTLock reader (r1:3 F9: this was a reader hard-coded to zero).
 */
export function limiterMultiplier(db: Db | null, env: Record<string, string | undefined>, lock: LockReader = lockReaderFromEnv(env)): (sub: { apiKeyId?: string; owner?: string }) => Promise<1 | 2 | 5> {
  const tiers = new Map<string, { at: number; m: 1 | 2 | 5 }>();
  return async (sub) => {
    const k = sub.apiKeyId ?? sub.owner ?? "";
    const hit = tiers.get(k);
    if (hit && Date.now() - hit.at < 60_000) return hit.m;
    const t = await tierOf({ ...(sub.apiKeyId ? { apiKeyId: sub.apiKeyId } : {}), ...(sub.owner ? { owner: sub.owner as Hex } : {}) }, { db, lock, cacheTtlMs: 60_000 }).catch(() => null);
    const m: 1 | 2 | 5 = t ? (t.tier === "pro" ? 5 : multiplierOf(t.tier === "lock_whale" ? "lock_whale" : t.tier === "lock_holder" ? "lock_holder" : null)) : 1;
    tiers.set(k, { at: Date.now(), m });
    return m;
  };
}

/** Build the createApp options for the api process. */
export async function gatewayFromEnv(cfg: ConfigFor<"api">, env: Record<string, string | undefined>, specs: RouteSpec[], overrides: Omit<PaymentOverrides, "db"> = {}): Promise<Pick<CreateAppOptions, "verifiers" | "preAuth" | "limiter" | "payment">> {
  const db = createDb(cfg.DATABASE_URL, { max: 6 });
  const redis = createRedis(cfg.REDIS_URL);
  const check = apiKeyCheck({ verify: (k) => verifyApiKey(db, k) });
  const trust = env.CAPSTAN_TRUST_FORWARDED_FOR === "1";
  return {
    verifiers: {
      owner_sig: ownerSigVerifier({ nonces: redisNonceStore(redis, NONCE_TTL_MS), host: cfg.PUBLIC_API_HOST, agentsOf: agentsOfDb(db) }),
      api_key: apiKeyVerifier(check),
      x402: x402Verifier({ check, spend: (id, route, usd) => spendCredit(db, id, route, usd), refund: (id, route, usd) => refundCredit(db, id, route, usd), ...(env.CAPSTAN_INTERNAL_TOKEN ? { internalToken: env.CAPSTAN_INTERNAL_TOKEN } : {}) }),
      internal: internalVerifier(env.CAPSTAN_INTERNAL_TOKEN),
    },
    preAuth: preAuthLimiter({ store: redisWindowStore(redis), fallback: memoryWindowStore(), ipOf: (c) => clientIp(c, trust) ?? "" }),
    limiter: rateLimiter({
      store: redisWindowStore(redis),
      fallback: memoryWindowStore(),
      ipOf: (c) => clientIp(c, trust) ?? "",
      multiplier: limiterMultiplier(db, env),
    }),
    payment: await paymentFromEnv(cfg, env, specs, { db, ...overrides }),
  };
}

export { LIMITS, limitsFor };
