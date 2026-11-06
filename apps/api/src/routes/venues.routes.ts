// GET /v1/venues (spec 13.1): one capabilities entry per adapter, including the pinned builder address of each fee
// rail, so the SDK can check the builder it signs for equals the address it pinned. Every entry says canWithdraw false.
// Each entry also says which network the venue reads on this deployment's profile; a venue with no testnet is marked
// mainnetReadOnly (mainnet market data, read only) on the local and testnet profiles.
import type { RouteSpec } from "@capstan/core";
import { venueNetworkEntry, type VenueCapabilities, type VenueId, type VenueNetworkEntry } from "@capstan/schema";

export interface VenuesRouteDeps {
  caps(): Promise<VenueCapabilities[]>;
  /** The environment the network profile is read from (default process.env). */
  env?: Record<string, string | undefined>;
}

export type VenueEntry = VenueCapabilities & { network: Omit<VenueNetworkEntry, "venue"> };

export function createVenueRoutes(getDeps: () => Promise<VenuesRouteDeps> | VenuesRouteDeps): RouteSpec[] {
  return [
    {
      method: "GET",
      path: "/venues",
      auth: "public",
      description: "Venue capabilities: execution, key type, delegation, builder fee rail and collateral",
      async handler(c) {
        const deps = await getDeps();
        const env = deps.env ?? process.env;
        const caps = await deps.caps();
        // invariant 2: nothing that claims withdrawal rights is ever served
        const out: VenueEntry[] = caps.filter((x) => x.canWithdraw === false).map((x) => {
          const { venue: _v, ...network } = venueNetworkEntry(x.venue, env);
          return { ...x, network };
        });
        return c.json(out);
      },
    },
  ];
}

export const VENUE_ORDER: readonly VenueId[] = ["hyperliquid", "lighter-mainnet", "lighter-rh", "aster", "variational", "arcus"];

export const routes: RouteSpec[] = createVenueRoutes(async () => {
  const { getAdapters } = await import("../adapters");
  return {
    async caps() {
      const { adapters } = await getAdapters();
      return VENUE_ORDER.filter((v) => adapters.has(v)).map((v) => adapters.get(v)!.caps);
    },
  };
});
