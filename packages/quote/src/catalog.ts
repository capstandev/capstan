// Catalog reader for quotes: a canonical asset's markets are the ones a reviewer approved (approved equivalences) plus
// the markets mapped to it (crypto majors map on an exact symbol). Unreviewed markets never join a comparison.
import { approvedEquivalences, rowToMarket } from "@capstan/catalog";
import type { Db } from "@capstan/core";
import { db as schema, type CanonicalAsset } from "@capstan/schema";
import { eq, inArray } from "drizzle-orm";
import type { QuoteMarket } from "./liq";
import type { CatalogReader } from "./route";

export function dbCatalogReader(db: Db): CatalogReader {
  async function byIds(ids: string[]): Promise<QuoteMarket[]> {
    if (!ids.length) return [];
    const rows = await db.select().from(schema.markets).where(inArray(schema.markets.id, ids));
    const byId = new Map(rows.map((r) => [r.id, rowToMarket(r)]));
    return ids.map((id) => byId.get(id)).filter((m): m is QuoteMarket => m !== undefined);
  }
  return {
    marketsByIds: byIds,
    async marketsForAsset(asset: CanonicalAsset) {
      const eqs = await approvedEquivalences(db, asset);
      const mapped = await db.select({ id: schema.markets.id }).from(schema.markets).where(eq(schema.markets.canonicalAsset, asset));
      const ids = [...new Set([...eqs.flatMap((e) => e.marketIds), ...mapped.map((r) => r.id)])].sort();
      return byIds(ids);
    },
  };
}

/** In-memory catalog (tests, tools). */
export function memoryCatalog(markets: QuoteMarket[]): CatalogReader {
  return {
    async marketsByIds(ids) {
      return ids.map((id) => markets.find((m) => m.id === id)).filter((m): m is QuoteMarket => m !== undefined);
    },
    async marketsForAsset(asset) {
      return markets.filter((m) => m.canonicalAsset === asset);
    },
  };
}
