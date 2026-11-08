// Funding routes (spec 13.1, E2):
//   GET /v1/funding?asset=           public: every venue's latest snapshot, data-only venues included, each with
//                                    source, asOf and dataFreshness. Rates are observed and change hourly.
//   GET /v1/funding/forecast?asset=  x402 $0.01: the next 8 settlements per market (written by funding-forecaster).
//   GET /v1/history/funding?marketId=&from=&to=   x402 $0.05 per 1,000 rows (DECISIONS #16): the route counts the rows
//                                    first, prices ceil(rows / 1000) x 0.05, caps a page at 10,000 rows, and delivers
//                                    exactly the priced rows: the window is frozen at pricing time (from to
//                                    min(to, now)) and count and rows are read in one repeatable-read snapshot, so a
//                                    row inserted after pricing is never returned and never charged.
// Pricing to delivery (R10): the gate calls priceRequest(c) and then the handler, two reads in two transactions. So
// priceRequest records its quote (the pricing clock and the priced row count) on the request, and the handler
// delivers on that same frozen window with at most the priced rows. A per-minute tick that lands between the two
// is never delivered, and a backfilled row inside the window cannot push the page past what was paid. With no gate
// in front (local runs) the handler prices the request itself first, so the same rule holds.
// The x402 gate itself is mounted by the gateway. /history/funding is not a flat price: its spec carries
// priced { usd: "0.05", perRows: 1000 } (the x402 PricedRoute shape) and priceRequest(c), which prices the
// request's own query and must run on the same request the handler then serves. The gate must charge priceRequest's amount, never priced.usd alone.
import { createDb, createMarketDataCache, createRedis, memoryMarketDataCache, type Db, type MarketDataCache, type RouteSpec } from "@capstan/core";
import { ANNUALISED_LABEL, dbCatalogReader, OBSERVED_NOTE, type CatalogReader, type Forecast } from "@capstan/quote";
import { db as schema, Dec, errorBody, FundingForecastQueryZ, FundingQueryZ, HistoryFundingQueryZ, type CanonicalAsset } from "@capstan/schema";
import { and, asc, count, eq, gt, gte, lte } from "drizzle-orm";
import type { Context } from "hono";

export const FORECAST_PRICE_USD = "0.01";
export const HISTORY_PRICE_PER_1000_USD = "0.05";
export const HISTORY_PAGE_ROWS = 10_000;

export interface HistoryRow {
  ts: string;
  marketId: string;
  ratePerInterval: string;
  intervalS: number;
  ratePerHour: string;
  rateAnnualised: string;
  source: string;
}

export interface HistoryPage {
  window: { from: string; to: string };
  totalRows: number;
  rows: HistoryRow[];
  pricing: { rows: number; usd: string; perThousandUsd: typeof HISTORY_PRICE_PER_1000_USD };
  nextCursor: string | null;
}

export interface HistoryPageOptions {
  /** Deliver at most this many rows (the rows a quote already priced). */
  maxRows?: number;
  /** Runs between pricing and delivery inside the snapshot (tests). */
  afterPriced?: () => Promise<void>;
  /**
   * Count and price only, read no rows (the quote the x402 gate takes on every request, paid or not: an unpaid
   * request must never cost a 10,000-row read, r1 F2).
   */
  countOnly?: boolean;
}

export interface HistoryReader {
  /** Count, price and read one page in one snapshot. */
  page(marketId: string, from: Date, to: Date, cursor: Date | null, opts?: HistoryPageOptions): Promise<HistoryPage>;
}

/** What priceRequest charged for one request, carried to that request's handler. */
export interface HistoryQuote {
  /** The pricing clock: the window end is min(to, nowMs). */
  nowMs: number;
  rows: number;
  usd: string;
}

/** Quotes by request. The gate and the handler see the same Request object, so the handler finds its quote. */
const quotes = new WeakMap<Request, HistoryQuote>();
export function historyQuoteFor(req: Request): HistoryQuote | null {
  return quotes.get(req) ?? null;
}


export interface FundingRouteDeps {
  catalog: CatalogReader;
  cache: Pick<MarketDataCache, "getFunding">;
  forecasts: { get(marketId: string): Promise<Forecast | null> };
  history: HistoryReader | null;
  now?: () => number;
}

/** ceil(rows / 1000) x $0.05, as an exact decimal string. */
export function historyPriceUsd(rows: number): string {
  if (!Number.isInteger(rows) || rows < 0) throw new RangeError("rows must be a non-negative integer");
  return Dec.toString(Dec.mul(Dec.parse(String(Math.ceil(rows / 1000)), 0), Dec.parse(HISTORY_PRICE_PER_1000_USD, 2), 2));
}

/** The window a history request is priced on: from to min(to, now), frozen at pricing time. */
export function frozenWindow(from: Date, to: Date, nowMs: number): { from: Date; to: Date } {
  return { from, to: new Date(Math.min(to.getTime(), nowMs)) };
}

export function dbHistoryReader(db: Db): HistoryReader {
  return {
    async page(marketId, from, to, cursor, opts = {}) {
      const cap = opts.maxRows ?? HISTORY_PAGE_ROWS;
      if (!Number.isInteger(cap) || cap < 0) throw new RangeError("maxRows must be a non-negative integer");
      return db.transaction(
        async (tx) => {
          const lower = cursor ? gt(schema.fundingTicks.ts, cursor) : gte(schema.fundingTicks.ts, from);
          const where = and(eq(schema.fundingTicks.marketId, marketId), lower, lte(schema.fundingTicks.ts, to));
          const [{ n: total }] = (await tx.select({ n: count() }).from(schema.fundingTicks).where(where)) as [{ n: number }];
          const pageRows = Math.min(total, HISTORY_PAGE_ROWS, cap);
          const usd = historyPriceUsd(pageRows);
          await opts.afterPriced?.();
          if (opts.countOnly) return { window: { from: from.toISOString(), to: to.toISOString() }, totalRows: total, rows: [], pricing: { rows: pageRows, usd, perThousandUsd: HISTORY_PRICE_PER_1000_USD }, nextCursor: null };
          const rows = await tx.select().from(schema.fundingTicks).where(where).orderBy(asc(schema.fundingTicks.ts)).limit(pageRows);
          const out: HistoryRow[] = rows.map((r) => ({
            ts: r.ts.toISOString(),
            marketId: r.marketId,
            ratePerInterval: String(r.ratePerInterval),
            intervalS: r.intervalS,
            ratePerHour: String(r.ratePerHour),
            rateAnnualised: Dec.toString(Dec.mul(Dec.parse(String(r.ratePerHour), 30, "half_even"), Dec.parse("8760", 0), 30)),
            source: r.source,
          }));
          return {
            window: { from: from.toISOString(), to: to.toISOString() },
            totalRows: total,
            rows: out,
            pricing: { rows: out.length, usd, perThousandUsd: HISTORY_PRICE_PER_1000_USD },
            nextCursor: total > pageRows && out.length ? out[out.length - 1]!.ts : null,
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}

function invalid(c: Context, issues: { path: PropertyKey[]; message: string }[]): Response {
  return c.json(errorBody("INVALID_INPUT", issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ")), 400);
}

/** What the x402 gate charges for a history request (the same snapshot rules as delivery). */
export async function priceHistory(history: HistoryReader, q: { marketId: string; from: string; to: string; cursor?: string | null }, nowMs: number): Promise<{ usd: string; rows: number }> {
  const w = frozenWindow(new Date(q.from), new Date(q.to), nowMs);
  const p = await history.page(q.marketId, w.from, w.to, q.cursor ? new Date(q.cursor) : null);
  return { usd: p.pricing.usd, rows: p.pricing.rows };
}

/** A route priced per request: priced.usd is the unit price per `perRows` rows, priceRequest the amount to charge. */
export type PerRowsPricedRoute = RouteSpec & {
  priced: { usd: string; perRows: 1000 };
  priceRequest(c: Context): Promise<{ usd: string; rows: number } | { error: string }>;
};
export type FundingRouteSpec = RouteSpec | PerRowsPricedRoute;

export function isPerRowsPriced(r: RouteSpec): r is PerRowsPricedRoute {
  return typeof (r as Partial<PerRowsPricedRoute>).priceRequest === "function" && (r as Partial<PerRowsPricedRoute>).priced?.perRows === 1000;
}

export function createFundingRoutes(getDeps: () => Promise<FundingRouteDeps> | FundingRouteDeps): FundingRouteSpec[] {
  /** Parse a history query into the frozen window and cursor, or an error message. */
  type HistoryQuery = { ok: false; error: string } | { ok: true; marketId: string; window: { from: Date; to: Date }; cursor: Date | null };
  const historyQuery = (q: Record<string, string>, nowMs: number): HistoryQuery => {
    const p = HistoryFundingQueryZ.safeParse(q);
    if (!p.success) return { ok: false, error: p.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ") };
    if (Date.parse(p.data.from) > Date.parse(p.data.to)) return { ok: false, error: "from must not be after to" };
    const cursor = q.cursor ? new Date(q.cursor) : null;
    if (cursor && !Number.isFinite(cursor.getTime())) return { ok: false, error: "cursor must be a time" };
    return { ok: true, marketId: p.data.marketId, window: frozenWindow(new Date(p.data.from), new Date(p.data.to), nowMs), cursor };
  };
  /** Price a history request and record the quote on the request for its handler. */
  const priceHistoryRequest = async (c: Context): Promise<{ usd: string; rows: number } | { error: string }> => {
    const d = await getDeps();
    if (!d.history) return { error: "history is not available" };
    const nowMs = (d.now ?? Date.now)();
    const h = historyQuery(c.req.query(), nowMs);
    if (!h.ok) return { error: h.error };
    const p = await d.history.page(h.marketId, h.window.from, h.window.to, h.cursor, { countOnly: true });
    quotes.set(c.req.raw, { nowMs, rows: p.pricing.rows, usd: p.pricing.usd });
    return { usd: p.pricing.usd, rows: p.pricing.rows };
  };
  return [
    {
      method: "GET",
      path: "/funding",
      auth: "public",
      description: "Latest observed funding per venue for an asset, data-only venues included",
      async handler(c) {
        const p = FundingQueryZ.safeParse(c.req.query());
        if (!p.success) return invalid(c, p.error.issues);
        const d = await getDeps();
        const markets = await d.catalog.marketsForAsset(p.data.asset as CanonicalAsset);
        const rows = [];
        for (const m of markets) {
          const f = await d.cache.getFunding(m.id);
          rows.push({
            marketId: m.id,
            venue: m.venue,
            dataFreshness: m.dataFreshness,
            executable: m.executable,
            status: f ? "ok" : "unavailable",
            source: f?.source ?? null,
            asOf: f?.asOf ?? null,
            ratePerInterval: f?.ratePerInterval ?? null,
            intervalS: f?.intervalS ?? m.fundingSettleIntervalS,
            ratePerHour: f?.ratePerHour ?? null,
            rateAnnualised: f?.rateAnnualised ?? null,
            annualisedLabel: ANNUALISED_LABEL,
            nextSettlementAt: f?.nextSettlementAt ?? null,
            note: OBSERVED_NOTE,
          });
        }
        return c.json({ asset: p.data.asset, note: OBSERVED_NOTE, rows });
      },
    },
    {
      method: "GET",
      path: "/funding/forecast",
      auth: "x402",
      priced: { usd: FORECAST_PRICE_USD },
      description: "Next 8 funding settlements per market (an estimate from observed rates)",
      async handler(c) {
        const p = FundingForecastQueryZ.safeParse(c.req.query());
        if (!p.success) return invalid(c, p.error.issues);
        const d = await getDeps();
        const markets = await d.catalog.marketsForAsset(p.data.asset as CanonicalAsset);
        const forecasts = [];
        for (const m of markets) {
          const f = await d.forecasts.get(m.id);
          forecasts.push(f ? { ...f, status: "ok" } : { marketId: m.id, settlements: [], status: "unavailable" });
        }
        return c.json({ asset: p.data.asset, note: "An estimate from observed funding; funding changes hourly.", forecasts });
      },
    },
    {
      method: "GET",
      path: "/history/funding",
      auth: "x402",
      priced: { usd: HISTORY_PRICE_PER_1000_USD, perRows: 1000 },
      description: "Funding history rows, $0.05 per 1,000 rows, pages of 10,000",
      priceRequest: priceHistoryRequest,
      async handler(c) {
        const d = await getDeps();
        if (!d.history) return c.json(errorBody("INTERNAL_ERROR", "history is not available"), 503);
        // deliver on the quote the gate charged; with no gate in front, price the request here first
        let quote = historyQuoteFor(c.req.raw);
        if (!quote) {
          const priced = await priceHistoryRequest(c);
          if ("error" in priced) return c.json(errorBody("INVALID_INPUT", priced.error), 400);
          quote = historyQuoteFor(c.req.raw)!;
        }
        const h = historyQuery(c.req.query(), quote.nowMs);
        if (!h.ok) return c.json(errorBody("INVALID_INPUT", h.error), 400);
        const page = await d.history.page(h.marketId, h.window.from, h.window.to, h.cursor, { maxRows: quote.rows });
        c.header("x-capstan-price-usd", quote.usd);
        return c.json({ marketId: h.marketId, annualisedLabel: ANNUALISED_LABEL, ...page, charged: { rows: quote.rows, usd: quote.usd } });
      },
    } satisfies PerRowsPricedRoute,
  ];
}

let resolved: Promise<FundingRouteDeps> | null = null;
async function envDeps(): Promise<FundingRouteDeps> {
  const env = process.env;
  const redis = env.REDIS_URL ? createRedis(env.REDIS_URL) : null;
  const db = env.DATABASE_URL ? createDb(env.DATABASE_URL, { max: 4 }) : null;
  return {
    catalog: db ? dbCatalogReader(db) : { marketsByIds: async () => [], marketsForAsset: async () => [] },
    cache: redis ? createMarketDataCache(redis) : memoryMarketDataCache(),
    forecasts: {
      async get(id) {
        const s = redis ? await redis.get(`md:forecast:${id}`) : null;
        return s ? (JSON.parse(s) as Forecast) : null;
      },
    },
    history: db ? dbHistoryReader(db) : null,
  };
}

export const routes: FundingRouteSpec[] = createFundingRoutes(() => (resolved ??= envDeps()));
