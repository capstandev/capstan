// GET /v1/venues (spec 13.1): one capabilities entry per adapter, including the pinned builder address of each fee
// rail, so the SDK can check the builder it signs for equals the address it pinned. Every entry says canWithdraw false.
import type { RouteSpec } from "@capstan/core";
import type { VenueCapabilities, VenueId } from "@capstan/schema";

export interface VenuesRouteDeps {
  caps(): Promise<VenueCapabilities[]>;
}

export function createVenueRoutes(getDeps: () => Promise<VenuesRouteDeps> | VenuesRouteDeps): RouteSpec[] {
  return [
    {
      method: "GET",
      path: "/venues",
      auth: "public",
      description: "Venue capabilities: execution, key type, delegation, builder fee rail and collateral",
      async handler(c) {
        const caps = await (await getDeps()).caps();
        // invariant 2: nothing that claims withdrawal rights is ever served
        return c.json(caps.filter((x) => x.canWithdraw === false));
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
