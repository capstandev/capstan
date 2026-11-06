// One owner's risk view from the venue accounts the owner onboarded (delegations table, any state: a stopped agent's
// positions are still open), shared by the api routes and the risk workers.
import { schema, type Db, type MarketDataCache } from "@capstan/core";
import type { CatalogReader } from "@capstan/quote";
import type { AccountSnapshot, Hex, VenueId, VenueIdentity } from "@capstan/schema";
import { sql } from "drizzle-orm";
import { readAccountsDetailed, type ReadAccountsDeps } from "./accounts";
import { buildRiskView, type CapstanRiskView } from "./view";

export interface OwnerViewDeps {
  identities(owner: Hex): Promise<VenueIdentity[]>;
  accounts: ReadAccountsDeps;
  catalog: CatalogReader;
  marks(marketIds: string[]): Promise<Map<string, string>>;
  now?: () => number;
}

export function dbIdentities(db: Db): OwnerViewDeps["identities"] {
  return async (owner) => {
    const rows = await db.select().from(schema.delegations).where(sql`lower(${schema.delegations.owner}) = ${owner.toLowerCase()}`);
    return rows.map((r) => ({ venue: r.venue as VenueId, owner: r.owner.toLowerCase() as Hex, ...(r.accountIndex !== null ? { accountIndex: r.accountIndex } : {}) }));
  };
}

export function cacheMarks(cache: Pick<MarketDataCache, "getMark">): OwnerViewDeps["marks"] {
  return async (ids) => {
    const out = new Map<string, string>();
    for (const id of new Set(ids)) {
      const m = await cache.getMark(id).catch(() => null);
      if (m) out.set(id, m.mark);
    }
    return out;
  };
}

export const marketIdsOf = (snaps: AccountSnapshot[]) => snaps.flatMap((s) => s.positions.map((p) => p.marketId));

export async function ownerView(owner: Hex, deps: OwnerViewDeps, venues?: VenueId[]): Promise<CapstanRiskView> {
  let ids = await deps.identities(owner);
  if (venues?.length) ids = ids.filter((i) => venues.includes(i.venue));
  const { snapshots, pending } = await readAccountsDetailed(ids, deps.accounts);
  const marks = await deps.marks(marketIdsOf(snapshots));
  return buildRiskView(owner, ids, snapshots, marks, deps.catalog, new Date((deps.now ?? Date.now)()), { pending });
}
