// Resource-server gate: wraps @x402/hono paymentMiddleware for Capstan's priced routes.
// - accepts come from acceptsFor (fixed rail order, exact atomic amounts, 60 s timeout per route);
// - the gate rebuilds the middleware when the rail state changes (a detection flip removes the eip3009 option on
//   the next request after the refresh);
// - an ops stop answers 503 "payments paused"; a route with no rail left answers 503 too (never served free).
import type { FacilitatorClient, HTTPRequestContext, RouteConfig, RoutesConfig } from "@x402/core/server";
import { x402ResourceServer } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/hono";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import type { Context, MiddlewareHandler } from "hono";
import { acceptsFor, MAX_TIMEOUT_SECONDS, type PricedRoute, type X402State } from "./accepts";
import { NETWORKS, type X402Env } from "./networks";

export const PAYMENTS_PAUSED = { error: { code: "X402_PAYMENTS_PAUSED", message: "payments paused" } } as const;
export const PAYMENTS_UNAVAILABLE = { error: { code: "X402_PAYMENTS_UNAVAILABLE", message: "no payment rail is available for this route" } } as const;

/** A resource server with the exact scheme registered on every network Capstan accepts. */
export function createResourceServer(facilitator: FacilitatorClient | FacilitatorClient[]): x402ResourceServer {
  const rs = new x402ResourceServer(facilitator);
  for (const n of [NETWORKS.base, NETWORKS.baseSepolia, NETWORKS.rhc, NETWORKS.rhcTestnet]) rs.register(n, new ExactEvmScheme());
  for (const n of [NETWORKS.solana, NETWORKS.solanaDevnet]) rs.register(n, new ExactSvmScheme());
  return rs;
}

export interface GateOptions {
  env: X402Env;
  state: () => X402State | Promise<X402State>;
  /** Ops stop: true = every priced route answers 503 "payments paused". */
  paused?: () => boolean | Promise<boolean>;
  /** Query parameter carrying the row count for perRows routes (default "limit"). */
  rowsParam?: string;
  /** Call the facilitator's /supported before the first paid request (default true; tests pass false). */
  syncFacilitatorOnStart?: boolean;
}

function toOption(req: PaymentRequirements) {
  return {
    scheme: req.scheme,
    network: req.network,
    payTo: req.payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    price: { asset: req.asset, amount: req.amount, extra: req.extra },
    extra: req.extra,
  };
}

function rowsOf(c: HTTPRequestContext["adapter"], param: string): number | undefined {
  const v = c.getQueryParam?.(param);
  const s = Array.isArray(v) ? v[0] : v;
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Build the @x402/hono routes config for a state. perRows routes price each request from its row count. */
export function routesConfig(routes: Record<string, PricedRoute>, state: X402State, opts: Pick<GateOptions, "env" | "rowsParam">): RoutesConfig {
  const out: Record<string, RouteConfig> = {};
  const param = opts.rowsParam ?? "limit";
  for (const [key, route] of Object.entries(routes)) {
    const base = acceptsFor(route, state, opts.env);
    const accepts = base.map((req, i) => {
      const o = toOption(req);
      if (!route.perRows) return o;
      return {
        ...o,
        price: (ctx: HTTPRequestContext) => {
          const r = acceptsFor(route, state, opts.env, { rows: rowsOf(ctx.adapter, param) })[i]!;
          return { asset: r.asset, amount: r.amount, extra: r.extra };
        },
      };
    });
    out[key] = { accepts, description: route.description, mimeType: "application/json" };
  }
  return out;
}

function stateKey(s: X402State): string {
  return JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function paymentGate(routes: Record<string, PricedRoute>, server: x402ResourceServer, opts: GateOptions): MiddlewareHandler {
  let cachedKey = "";
  let cached: MiddlewareHandler | null = null;
  let emptyRoutes = new Set<string>();
  const keys = Object.keys(routes);
  const matchKey = (c: Context): string | null => {
    const m = c.req.method.toUpperCase();
    for (const k of keys) {
      const [km, kp] = k.includes(" ") ? (k.split(" ", 2) as [string, string]) : ["*", k];
      if (km !== "*" && km !== m) continue;
      if (pathMatches(kp, c.req.path)) return k;
    }
    return null;
  };
  return async (c, next) => {
    const key = matchKey(c);
    if (!key) return next();
    if (opts.paused && (await opts.paused())) return c.json(PAYMENTS_PAUSED, 503);
    const state = await opts.state();
    const sk = stateKey(state);
    if (!cached || sk !== cachedKey) {
      const cfg = routesConfig(routes, state, opts) as Record<string, RouteConfig>;
      emptyRoutes = new Set(Object.entries(cfg).filter(([, r]) => (Array.isArray(r.accepts) ? r.accepts.length === 0 : !r.accepts)).map(([k]) => k));
      const nonEmpty = Object.fromEntries(Object.entries(cfg).filter(([k]) => !emptyRoutes.has(k)));
      cached = paymentMiddleware(nonEmpty, server, undefined, undefined, opts.syncFacilitatorOnStart ?? true);
      cachedKey = sk;
    }
    if (emptyRoutes.has(key)) return c.json(PAYMENTS_UNAVAILABLE, 503);
    return cached(c, next);
  };
}

/** Path pattern match with Hono-style ":param" segments and a trailing "*". */
export function pathMatches(pattern: string, path: string): boolean {
  const p = pattern.split("/").filter(Boolean);
  const a = path.split("/").filter(Boolean);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*") return true;
    if (i >= a.length) return false;
    if (p[i]!.startsWith(":") || p[i] === "[param]") continue;
    if (p[i] !== a[i]) return false;
  }
  return p.length === a.length;
}
