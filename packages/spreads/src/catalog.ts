// Database catalog for the scanner and the planner: every equivalence row (the callers keep only approved ones) and
// markets by id through the quote engine's catalog reader.
import type { Db } from "@capstan/core";
import { dbCatalogReader } from "@capstan/quote";
import { db as schema, type CanonicalAsset } from "@capstan/schema";
import { eq } from "drizzle-orm";
import type { SpreadCatalog } from "./scan";

export function dbSpreadCatalog(db: Db): SpreadCatalog {
  const r = dbCatalogReader(db);
  return {
    marketsByIds: (ids) => r.marketsByIds(ids),
    async equivalences(asset?: CanonicalAsset) {
      const q = db.select().from(schema.equivalences);
      const rows = asset ? await q.where(eq(schema.equivalences.canonicalAsset, asset)) : await q;
      return rows.map((x) => ({ id: x.id, canonicalAsset: x.canonicalAsset, marketIds: x.marketIds, status: x.status, notes: x.notes }));
    },
  };
}
