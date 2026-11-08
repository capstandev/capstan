// Drop-in route contract: apps/api/src/routes/<area>.routes.ts exports `routes: RouteSpec[]`. Auth is declared per
// route; the mount refuses a route without it (deny by default).
import type { Context } from "hono";

export type RouteAuth = "public" | "owner_sig" | "api_key" | "x402" | "internal";
export const ROUTE_AUTHS: readonly RouteAuth[] = ["public", "owner_sig", "api_key", "x402", "internal"];

export type Handler = (c: Context) => Response | Promise<Response>;

/**
 * A route that routes an action to a venue (spec 10: orders, onboarding, spread legs). The api mount refuses a write
 * route unless an eligibility edge is wired, and the edge runs before the handler on every call (todo 23).
 * Default extraction: venue from `?venue=` or the JSON body's `venue`, else the prefix of `marketId`.
 */
export interface RouteWrite {
  action: "onboarding" | "order" | "spread_leg";
  venue?: (c: Context, body: unknown) => string | null | Promise<string | null>;
  marketId?: (c: Context, body: unknown) => string | null | Promise<string | null>;
  /** The owner the write acts for when the auth names none, ahead of a body owner (onboarding submit: the bundle's; order submit and claim: the build's). Never recorded unless authenticated (r1 R1-04). */
  owner?: (c: Context, body: unknown) => string | null | Promise<string | null>;
  /** True for equity (stock) markets. Default: every Hyperliquid HIP-3 dex market counts as equity (strict). */
  isEquityMarket?: (c: Context, body: unknown, marketId: string | null) => boolean | Promise<boolean>;
}

export interface RouteSpec {
  method: "GET" | "POST" | "DELETE";
  path: string; // relative to /v1, e.g. '/markets/:id/book'
  auth: RouteAuth;
  /** Other auth kinds that also admit the request (e.g. owner_sig or api_key on a build route). */
  authAlt?: RouteAuth[];
  handler: Handler;
  priced?: { usd: string }; // x402 price, decimal string
  description?: string;
  write?: RouteWrite;
}
