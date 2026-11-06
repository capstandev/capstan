// POST /v1/quote and GET /v1/quote?... (spec 13.1, E1): every venue side by side with venue fee, builder fee, slippage
// and funding before anything is signed. Public; rate limits are applied by the gateway work. The request is validated
// with zod (size or notional, leverage within the market maximum); the answer is stored in quote_snapshots under
// hash = sha256(JCS(quote)) and that hash is returned as receiptHint.
import { createDb, createMarketDataCache, createRedis, memoryMarketDataCache, type RouteSpec } from "@capstan/core";
import { cachedDepegReader, dbCatalogReader, routeQuote, type CatalogReader, type DepegReader, type EngineRouteQuote, type QuoteAdapter, type QuoteDeps } from "@capstan/quote";
import { CapstanError, db as schema, errorBody, QuoteRequestZ, type QuoteRequest, type VenueId } from "@capstan/schema";
import { recordQuoteStaleness } from "@capstan/telemetry";
import type { Context } from "hono";

export interface QuoteStore {
  put(id: string, hash: string, body: EngineRouteQuote): Promise<void>;
}

export interface QuoteRouteDeps extends Omit<QuoteDeps, "now"> {
  store: QuoteStore | null;
  now?: () => number;
}

const NUMERIC = new Set(["leverage", "holdHours"]);

/** GET query to the same object a POST body carries (marketIds comma-separated, numbers coerced). */
export function queryToRequest(q: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === "") continue;
    if (k === "marketIds") out[k] = v.split(",").map((s) => s.trim()).filter(Boolean);
    else if (NUMERIC.has(k)) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

function invalid(c: Context, message: string): Response {
  return c.json(errorBody("INVALID_INPUT", message), 400);
}

/** Leverage within the market maximum: every named market, or at least one market of the asset. */
export async function leverageProblem(req: QuoteRequest, catalog: CatalogReader): Promise<string | null> {
  const ms = req.marketIds?.length ? await catalog.marketsByIds(req.marketIds) : await catalog.marketsForAsset(req.canonicalAsset!);
  if (req.marketIds?.length) {
    const missing = req.marketIds.filter((id) => !ms.some((m) => m.id === id));
    if (missing.length) return `unknown market ${missing[0]}`;
    const over = ms.find((m) => m.maxLeverage !== null && req.leverage > m.maxLeverage);
    if (over) return `leverage ${req.leverage} is above the ${over.id} maximum ${over.maxLeverage}`;
    return null;
  }
  if (!ms.length) return `no reviewed markets for ${req.canonicalAsset}`;
  const maxes = ms.filter((m) => m.venue !== "variational" && m.venue !== "arcus").map((m) => m.maxLeverage);
  if (maxes.length && maxes.every((x) => x !== null && req.leverage > x)) return `leverage ${req.leverage} is above every market maximum`;
  return null;
}

async function handle(c: Context, raw: unknown, getDeps: () => Promise<QuoteRouteDeps> | QuoteRouteDeps): Promise<Response> {
  const parsed = QuoteRequestZ.safeParse(raw);
  if (!parsed.success) return invalid(c, parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "));
  const req = parsed.data as QuoteRequest;
  const deps = await getDeps();
  const problem = await leverageProblem(req, deps.catalog);
  if (problem) return invalid(c, problem);
  try {
    const q = await routeQuote(req, { ...deps, now: deps.now ?? Date.now });
    // age of the book behind every priced leg (alert rule: T1 above 3 s for 5 minutes)
    for (const l of q.legs) if (l.asOf) recordQuoteStaleness(l.venue, l.staleMs);
    if (deps.store) await deps.store.put(q.requestId, q.receiptHint, q);
    return c.json(q);
  } catch (e) {
    if (e instanceof CapstanError) return c.json(e.toBody(), e.status as 400);
    throw e;
  }
}

export function createQuoteRoutes(getDeps: () => Promise<QuoteRouteDeps> | QuoteRouteDeps): RouteSpec[] {
  return [
    {
      method: "POST",
      path: "/quote",
      auth: "public",
      description: "Quote every venue side by side: venue fee, builder fee, slippage and observed funding",
      async handler(c) {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return invalid(c, "body must be JSON");
        }
        return handle(c, body, getDeps);
      },
    },
    {
      method: "GET",
      path: "/quote",
      auth: "public",
      description: "Quote every venue side by side (query form)",
      handler: (c) => handle(c, queryToRequest(c.req.query()), getDeps),
    },
  ];
}

export function dbQuoteStore(db: ReturnType<typeof createDb>): QuoteStore {
  return {
    async put(id, hash, body) {
      await db.insert(schema.quoteSnapshots).values({ id, hash, body }).onConflictDoNothing();
    },
  };
}

const unknownDepeg: DepegReader = { usdgUsdcBps: async () => null, usdtUsdcBps: async () => null };

let resolved: Promise<QuoteRouteDeps> | null = null;

/**
 * Wiring from the environment. Venue adapters come from the shared composition (apps/api/src/adapters.ts, built by
 * the gateway work); until it exists, the keyless read-only feeds and the Aster reader are wired here.
 */
async function envDeps(): Promise<QuoteRouteDeps> {
  const env = process.env;
  const redis = env.REDIS_URL ? createRedis(env.REDIS_URL) : null;
  const cache = redis ? createMarketDataCache(redis) : memoryMarketDataCache();
  const db = env.DATABASE_URL ? createDb(env.DATABASE_URL, { max: 4 }) : null;
  const adapters = new Map<VenueId, QuoteAdapter>();
  const { defaultVariationalAdapter } = await import("@capstan/adapter-variational");
  const { defaultArcusAdapter } = await import("@capstan/adapter-arcus");
  adapters.set("variational", defaultVariationalAdapter({ redis, cache }));
  adapters.set("arcus", defaultArcusAdapter({ redis, cache }));
  const aster = await import("@capstan/adapter-aster");
  const reader = aster.defaultAsterReader({ redis, cache });
  adapters.set("aster", { caps: aster.asterCaps("0x0000000000000000000000000000000000000000", {}), getBook: (id, depth) => reader.getBook(id, depth), getFunding: (id) => reader.getFunding(id) });
  const catalog: CatalogReader = db ? dbCatalogReader(db) : { marketsByIds: async () => [], marketsForAsset: async () => [] };
  return { adapters, cache, catalog, depeg: redis ? cachedDepegReader(redis) : unknownDepeg, store: db ? dbQuoteStore(db) : null };
}

export const routes: RouteSpec[] = createQuoteRoutes(() => (resolved ??= envDeps()));
