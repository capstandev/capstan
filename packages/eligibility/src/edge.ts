// Eligibility at the edge (spec 10, F1): the api runs this before every write route's handler. It decides from the
// caller's IP country, the owner's declaration and the venue matrix, sets `eligibilityDecisionId` (and
// `eligibility`) on the context when allowed, and answers 403 with the code and a refusal receipt id otherwise.
// A refusal never runs the handler. If the receipt cannot be issued the request is still refused.
import type { Db, RouteSpec, RouteWrite } from "@capstan/core";
import type { ReceiptDraft } from "@capstan/receipts";
import { errorBody, type Hex, type Receipt, type VenueId, VENUE_IDS } from "@capstan/schema";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import { decide, type EligibilityDecision } from "./decide";
import type { GeoLookup } from "./geo";
import { refusalBody, refusalReceipt } from "./refusal";
import type { EligibilityRule } from "./rules";

export interface EdgeDeps {
  geo: GeoLookup;
  db: Db;
  now: () => Date;
  issue: (d: ReceiptDraft) => Promise<Receipt>;
  /** Client IP. Default: the socket address; `trustForwardedFor` reads the first X-Forwarded-For entry instead. */
  ipOf?: (c: Context) => string | null;
  trustForwardedFor?: boolean;
  rules?: () => Promise<EligibilityRule[]>;
  onError?: (e: Error) => void;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;

export function clientIp(c: Context, trustForwardedFor = false): string | null {
  if (trustForwardedFor) {
    const xff = c.req.header("x-forwarded-for");
    const first = xff?.split(",")[0]?.trim();
    if (first) return first;
  }
  try {
    const a = getConnInfo(c).remote.address;
    return typeof a === "string" && a.length > 0 ? a : null;
  } catch {
    return null;
  }
}

async function bodyOf(c: Context): Promise<unknown> {
  if (c.req.method === "GET") return null;
  const type = c.req.header("content-type") ?? "";
  if (!type.includes("application/json")) return null;
  try {
    return await c.req.json(); // Hono caches the parsed body, so the handler reads it again for free
  } catch {
    return null;
  }
}

const field = (b: unknown, k: string): unknown => (b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>)[k] : undefined);
const ctxGet = (c: Context, k: string): unknown => (c as unknown as { get(k: string): unknown }).get(k);
const ctxSet = (c: Context, k: string, v: unknown): void => (c as unknown as { set(k: string, v: unknown): void }).set(k, v);
const asVenue = (v: unknown): VenueId | null => (typeof v === "string" && (VENUE_IDS as readonly string[]).includes(v) ? (v as VenueId) : null);

/** Strict default: any Hyperliquid market on a HIP-3 dex counts as an equity market. */
export function defaultIsEquity(marketId: string | null): boolean {
  if (!marketId) return false;
  const [venue, dex] = marketId.split(":");
  return venue === "hyperliquid" && dex !== undefined && dex !== "-" && dex !== "";
}

export function edgeMiddleware(deps: EdgeDeps & { write: RouteWrite }): MiddlewareHandler {
  const w = deps.write;
  return async (c, next) => {
    const body = await bodyOf(c);
    const rawMarket = w.marketId ? await w.marketId(c, body) : (c.req.query("marketId") ?? field(body, "marketId"));
    const marketId = typeof rawMarket === "string" && rawMarket.length > 0 && rawMarket.length < 128 ? rawMarket : null;
    const venue = asVenue(w.venue ? await w.venue(c, body) : (c.req.query("venue") ?? field(body, "venue") ?? marketId?.split(":")[0]));
    if (!venue) return c.json(errorBody("INVALID_INPUT", "venue is required"), 400);
    const authOwner = ctxGet(c, "owner");
    const rawOwner = typeof authOwner === "string" ? authOwner : field(body, "owner");
    const owner = typeof rawOwner === "string" && ADDR.test(rawOwner) ? (rawOwner as Hex) : undefined;
    const authAgent = ctxGet(c, "agentRef");
    const rawAgent = typeof authAgent === "string" ? authAgent : field(body, "agentRef");
    const agentRef = typeof rawAgent === "string" && rawAgent.length > 0 && rawAgent.length < 128 ? rawAgent : undefined;
    const isEquityMarket = w.isEquityMarket ? await w.isEquityMarket(c, body, marketId) : defaultIsEquity(marketId);
    const ip = (deps.ipOf ?? ((x: Context) => clientIp(x, deps.trustForwardedFor)))(c) ?? "";

    const decision: EligibilityDecision = await decide(
      { ip, venue, action: w.action, isEquityMarket, ...(owner ? { owner } : {}), ...(agentRef ? { agentRef } : {}), ...(marketId ? { marketId } : {}) },
      { geo: deps.geo, db: deps.db, now: deps.now, ...(deps.rules ? { rules: deps.rules } : {}) },
    );
    if (decision.allowed) {
      ctxSet(c, "eligibilityDecisionId", decision.id);
      ctxSet(c, "eligibility", decision);
      await next();
      return;
    }
    let receiptId: string | undefined;
    try {
      const r = await refusalReceipt(decision, { method: c.req.method, path: c.req.path, body }, deps.issue, { owner: owner ?? null, agentRef: agentRef ?? null, venue, marketId });
      receiptId = r.receiptId;
    } catch (e) {
      deps.onError?.(e as Error);
    }
    return c.json(refusalBody(decision.code!, receiptId), 403);
  };
}

/** The factory the api mount takes: one edge per write route, from the route's own `write` declaration. */
export function edgeFor(deps: EdgeDeps): (spec: RouteSpec) => MiddlewareHandler {
  return (spec) => {
    if (!spec.write) throw new Error(`edgeFor: ${spec.method} ${spec.path} is not a write route`);
    return edgeMiddleware({ ...deps, write: spec.write });
  };
}
