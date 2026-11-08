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

/**
 * The body exactly as the handler will read it. Handlers call c.req.json(), which Hono parses whatever the
 * content type says, so the edge parses the raw text the same way: a text/plain body can no longer hide the market,
 * the venue or the agent from the decision while the handler still builds on them (security review r1 ELIG-1).
 */
async function bodyOf(c: Context): Promise<unknown> {
  if (c.req.method === "GET" || c.req.method === "HEAD") return null;
  let text: string;
  try {
    text = await c.req.text(); // Hono caches the body, so the handler reads it again for free
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
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
    // r1 ELIG-1: the decision is made on the venue and market the handler will use. A write route never reads them
    // from the query string (the handler never does): the route's own hook, else the body, else the market's prefix,
    // and a venue that disagrees with the market's prefix is refused
    const rawMarket = w.marketId ? await w.marketId(c, body) : field(body, "marketId");
    const marketId = typeof rawMarket === "string" && rawMarket.length > 0 && rawMarket.length < 128 ? rawMarket : null;
    const marketVenue = marketId ? asVenue(marketId.split(":")[0]) : null;
    const named = w.venue ? await w.venue(c, body) : field(body, "venue");
    const venue = named === undefined || named === null ? marketVenue : asVenue(named);
    if (!venue) return c.json(errorBody("INVALID_INPUT", "venue is required"), 400);
    if (marketId && marketVenue !== venue) return c.json(errorBody("INVALID_INPUT", "The market is not on this venue."), 400);
    const authOwner = ctxGet(c, "owner");
    const hookOwner = w.owner ? await w.owner(c, body) : undefined;
    // the write acts for a stored record's owner (a build, a bundle): an authenticated caller who is not that owner
    // is refused before any decision or receipt is written (r1 R1-04)
    if (typeof authOwner === "string" && typeof hookOwner === "string" && hookOwner.toLowerCase() !== authOwner.toLowerCase()) return c.json(errorBody("UNAUTHORIZED", "The signature does not belong to this record's owner."), 401);
    const rawOwner = typeof authOwner === "string" ? authOwner : (hookOwner ?? field(body, "owner"));
    const owner = typeof rawOwner === "string" && ADDR.test(rawOwner) ? (rawOwner as Hex) : undefined;
    // r1 ELIG-2 / F2: only an authenticated owner (owner_sig, or an API key made for that wallet) is written into
    // the decision log and a refusal receipt; an owner named only in the body is used to evaluate, never recorded
    const ownerAuthed = ctxGet(c, "ownerAuthed") === true && typeof authOwner === "string";
    const authAgent = ctxGet(c, "agentRef");
    const rawAgent = typeof authAgent === "string" ? authAgent : field(body, "agentRef");
    const agentRef = typeof rawAgent === "string" && rawAgent.length > 0 && rawAgent.length < 128 ? rawAgent : undefined;
    const isEquityMarket = w.isEquityMarket ? await w.isEquityMarket(c, body, marketId) : defaultIsEquity(marketId);
    const ip = (deps.ipOf ?? ((x: Context) => clientIp(x, deps.trustForwardedFor)))(c) ?? "";

    const decision: EligibilityDecision = await decide(
      { ip, venue, action: w.action, isEquityMarket, ...(owner ? { owner } : {}), ...(agentRef ? { agentRef } : {}), ...(marketId ? { marketId } : {}), ...(ownerAuthed ? {} : { recordOwner: false }) },
      { geo: deps.geo, db: deps.db, now: deps.now, ...(deps.rules ? { rules: deps.rules } : {}) },
    );
    if (decision.allowed) {
      ctxSet(c, "eligibilityDecisionId", decision.id);
      ctxSet(c, "eligibility", decision);
      // what the decision was made on, so a handler can check it builds on the same venue and market
      ctxSet(c, "eligibilityScope", { venue, marketId });
      await next();
      return;
    }
    let receiptId: string | undefined;
    try {
      const r = await refusalReceipt(decision, { method: c.req.method, path: c.req.path, body }, deps.issue, { owner: ownerAuthed ? (owner ?? null) : null, agentRef: ownerAuthed ? (agentRef ?? null) : null, venue, marketId });
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

/**
 * False when the edge decided on another venue or market than the one the handler is about to use (r1 ELIG-1).
 * A route mounted without the real edge (a unit test's stand-in) records no scope and is not checked here.
 */
export function edgeScopeMatches(c: Context, venue: string, marketId: string | null): boolean {
  const s = ctxGet(c, "eligibilityScope") as { venue: string; marketId: string | null } | undefined;
  if (!s) return true;
  if (s.venue !== venue) return false;
  return s.marketId === null || marketId === null || s.marketId === marketId;
}
