// Drop-in route contract: apps/api/src/routes/<area>.routes.ts exports `routes: RouteSpec[]`. Auth is declared per
// route; the mount refuses a route without it (deny by default).
import type { Context } from "hono";

export type RouteAuth = "public" | "owner_sig" | "api_key" | "x402" | "internal";
export const ROUTE_AUTHS: readonly RouteAuth[] = ["public", "owner_sig", "api_key", "x402", "internal"];

export type Handler = (c: Context) => Response | Promise<Response>;

export interface RouteSpec {
  method: "GET" | "POST" | "DELETE";
  path: string; // relative to /v1, e.g. '/markets/:id/book'
  auth: RouteAuth;
  handler: Handler;
  priced?: { usd: string }; // x402 price, decimal string
  description?: string;
}
