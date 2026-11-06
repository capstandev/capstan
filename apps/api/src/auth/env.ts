// The gateway from the environment: verifiers, rate limiter and the x402 payment middleware for createApp. The api
// role's config (loadConfig('api')) holds the ports, Redis, the database and the x402 switch; payTo addresses and the
// public RPCs for the token facts come from X402_PAY_TO_EVM, X402_PAY_TO_SOL, BASE_RPC_URL and RHC_RPC_URL.
// With X402_ENABLED off (the default) every priced route answers 503 "payments unavailable": never served free.
import { createDb, createRedis, redisNonceStore, schema, type ConfigFor, type Db, type RouteSpec } from "@capstan/core";
import { clientIp } from "@capstan/eligibility";
import { LIMITS, limitsFor, multiplierOf, spendCredit, tierOf, verifyApiKey, type LockReader } from "@capstan/plans";
import { errorBody, type Hex } from "@capstan/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { CreateAppOptions } from "../app";
import { memoryWindowStore, rateLimiter, redisWindowStore } from "../ratelimit";
import { apiKeyCheck, apiKeyVerifier, internalVerifier, NONCE_TTL_MS, ownerSigVerifier, x402Verifier } from "./index";

export const agentsOfDb = (db: Db) => async (owner: Hex) => {
  const rows = await db
    .select({ id: schema.delegations.id, agentAddress: schema.delegations.agentAddress })
    .from(schema.delegations)
    .where(and(eq(schema.delegations.owner, owner.toLowerCase()), eq(schema.delegations.state, "active"), isNotNull(schema.delegations.agentAddress)));
  return rows.map((r) => ({ address: r.agentAddress as Hex, agentRef: r.id }));
};

/** The x402 routes table for the payment middleware, from the mounted specs: `<METHOD> /v1<path>`. */
export function pricedRoutes(specs: RouteSpec[]): Record<string, { usd: string; description: string; perRows?: 1000 }> {
  const out: Record<string, { usd: string; description: string; perRows?: 1000 }> = {};
  for (const s of specs) if (s.auth === "x402" && s.priced) out[`${s.method} /v1${s.path}`] = { usd: s.priced.usd, description: s.description ?? s.path, ...((s.priced as { perRows?: 1000 }).perRows ? { perRows: 1000 as const } : {}) };
  return out;
}

const unavailable: MiddlewareHandler = async (c) => c.json(errorBody("X402_PAYMENTS_UNAVAILABLE", "payments unavailable"), 503);

async function paymentFromEnv(cfg: ConfigFor<"api">, env: Record<string, string | undefined>, specs: RouteSpec[]): Promise<MiddlewareHandler> {
  if (!cfg.X402_ENABLED) return unavailable;
  const payEvm = env.X402_PAY_TO_EVM as Hex | undefined;
  const paySol = env.X402_PAY_TO_SOL;
  if (!payEvm || !paySol) return unavailable;
  const x = await import("@capstan/x402");
  const { HTTPFacilitatorClient } = await import("@x402/core/server");
  const { createPublicClient, http } = await import("viem");
  const net: "mainnet" | "testnet" = cfg.CAPSTAN_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const routes = pricedRoutes(specs);
  const clients: Record<string, unknown> = {};
  if (env.BASE_RPC_URL) clients[net === "mainnet" ? "eip155:8453" : "eip155:84532"] = createPublicClient({ transport: http(env.BASE_RPC_URL) });
  if (env.RHC_RPC_URL) clients[net === "mainnet" ? "eip155:4663" : "eip155:46630"] = createPublicClient({ transport: http(env.RHC_RPC_URL) });
  let state: Awaited<ReturnType<typeof x.buildX402State>>["state"] | null = null;
  const loadState = async () =>
    (state ??= (
      await x.buildX402State({ env: net, routes, clients: clients as never, usdgEip3009: { "4663": cfg.X402_USDG_EIP3009_MAINNET, "46630": true }, payTo: { evm: payEvm, sol: paySol } })
    ).state);
  const gate = x.paymentGate(routes, x.createResourceServer(new HTTPFacilitatorClient({ url: cfg.FACILITATOR_URL })), { env: net, state: loadState });
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

/** Build the createApp options for the api process. */
export async function gatewayFromEnv(cfg: ConfigFor<"api">, env: Record<string, string | undefined>, specs: RouteSpec[]): Promise<Pick<CreateAppOptions, "verifiers" | "limiter" | "payment">> {
  const db = createDb(cfg.DATABASE_URL, { max: 6 });
  const redis = createRedis(cfg.REDIS_URL);
  const check = apiKeyCheck({ verify: (k) => verifyApiKey(db, k) });
  const lock: LockReader = { lockedOf: async () => ({ amount: 0n, unlockAt: 0n }) };
  const tiers = new Map<string, { at: number; m: 1 | 2 | 5 }>();
  const trust = env.CAPSTAN_TRUST_FORWARDED_FOR === "1";
  return {
    verifiers: {
      owner_sig: ownerSigVerifier({ nonces: redisNonceStore(redis, NONCE_TTL_MS), host: cfg.PUBLIC_API_HOST, agentsOf: agentsOfDb(db) }),
      api_key: apiKeyVerifier(check),
      x402: x402Verifier({ check, spend: (id, route, usd) => spendCredit(db, id, route, usd), ...(env.CAPSTAN_INTERNAL_TOKEN ? { internalToken: env.CAPSTAN_INTERNAL_TOKEN } : {}) }),
      internal: internalVerifier(env.CAPSTAN_INTERNAL_TOKEN),
    },
    limiter: rateLimiter({
      store: redisWindowStore(redis),
      fallback: memoryWindowStore(),
      ipOf: (c) => clientIp(c, trust) ?? "",
      async multiplier(sub) {
        const k = sub.apiKeyId ?? sub.owner ?? "";
        const hit = tiers.get(k);
        if (hit && Date.now() - hit.at < 60_000) return hit.m;
        const t = await tierOf({ ...(sub.apiKeyId ? { apiKeyId: sub.apiKeyId } : {}), ...(sub.owner ? { owner: sub.owner as Hex } : {}) }, { db, lock, cacheTtlMs: 60_000 }).catch(() => null);
        const m: 1 | 2 | 5 = t ? (t.tier === "pro" ? 5 : multiplierOf(t.tier === "lock_whale" ? "lock_whale" : t.tier === "lock_holder" ? "lock_holder" : null)) : 1;
        tiers.set(k, { at: Date.now(), m });
        return m;
      },
    }),
    payment: await paymentFromEnv(cfg, env, specs),
  };
}

export { LIMITS, limitsFor };
