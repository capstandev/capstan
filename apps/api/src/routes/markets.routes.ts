// GET /v1/markets?venue=&dex=&asset=&executable= and GET /v1/markets/{id}/book?depth=20 (spec 13.1). Markets come from
// the catalog (todo 03); a market is executable only after review. Books come from the venue adapter (cache first).
import { createDb, schema, type Db, type RouteSpec } from "@capstan/core";
import { rowToMarket } from "@capstan/catalog";
import { BookQueryZ, CapstanError, errorBody, MarketsQueryZ, type Market, type OrderBook, type VenueId } from "@capstan/schema";
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";

export interface MarketsRouteDeps {
  list(f: { venue?: VenueId; dex?: string; asset?: string; executable?: boolean }): Promise<Market[]>;
  book(marketId: string, depth: number): Promise<OrderBook | null>;
}

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.map((i) => `${i.path.map(String).join(".") || "query"}: ${i.message}`).join("; ");

export function createMarketRoutes(getDeps: () => Promise<MarketsRouteDeps> | MarketsRouteDeps): RouteSpec[] {
  return [
    {
      method: "GET",
      path: "/markets",
      auth: "public",
      description: "Markets across venues, each with its own contract details and whether it is executable",
      async handler(c) {
        const q = MarketsQueryZ.safeParse(c.req.query());
        if (!q.success) return c.json(errorBody("INVALID_INPUT", issues(q.error)), 400);
        const markets = await (await getDeps()).list(q.data as { venue?: VenueId; dex?: string; asset?: string; executable?: boolean });
        return c.json({ markets });
      },
    },
    {
      method: "GET",
      path: "/markets/:id/book",
      auth: "public",
      description: "Order book for one market (top levels, newest cached)",
      async handler(c) {
        const q = BookQueryZ.safeParse({ id: c.req.param("id"), depth: c.req.query("depth") });
        if (!q.success) return c.json(errorBody("INVALID_INPUT", issues(q.error)), 400);
        try {
          const b = await (await getDeps()).book(q.data.id, q.data.depth);
          return b ? c.json(b) : c.json(errorBody("NOT_FOUND", "Unknown market."), 404);
        } catch (e) {
          if (e instanceof CapstanError) return c.json(e.toBody(), e.status as 400);
          throw e;
        }
      },
    },
  ];
}

export function dbMarkets(db: Db) {
  return async (f: { venue?: VenueId; dex?: string; asset?: string; executable?: boolean }): Promise<Market[]> => {
    const m = schema.markets;
    const where: SQL[] = [];
    if (f.venue) where.push(eq(m.venue, f.venue));
    if (f.dex !== undefined) where.push(f.dex === "-" ? isNull(m.dex) : eq(m.dex, f.dex));
    if (f.asset) where.push(eq(m.canonicalAsset, f.asset));
    if (f.executable !== undefined) where.push(eq(m.executable, f.executable));
    const rows = await db.select().from(m).where(where.length ? and(...where) : undefined).orderBy(asc(m.id)).limit(5000);
    return rows.map(rowToMarket);
  };
}

let resolved: Promise<MarketsRouteDeps> | null = null;
async function envDeps(): Promise<MarketsRouteDeps> {
  if (!process.env.DATABASE_URL) throw new CapstanError("INTERNAL_ERROR", "DATABASE_URL is not set");
  const db = createDb(process.env.DATABASE_URL, { max: 4 });
  const { getAdapters } = await import("../adapters");
  return {
    list: dbMarkets(db),
    async book(id, depth) {
      const venue = id.split(":")[0] as VenueId;
      const a = (await getAdapters()).adapters.get(venue);
      if (!a) return null;
      return a.getBook(id, depth);
    },
  };
}

export const routes: RouteSpec[] = createMarketRoutes(() => (resolved ??= envDeps()));
