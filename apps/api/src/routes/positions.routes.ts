// GET /v1/positions?owner=&venues= (spec 13.1): the owner's open positions, one entry per venue account, read with
// the owner's own signature (purpose 'read', SIG-1). Aster positions come only from the owner's ingested signed reads.
import type { RouteSpec } from "@capstan/core";
import { BANNER } from "@capstan/risk";
import { errorBody, PositionsQueryZ, type Hex, type VenueId } from "@capstan/schema";
import { envRiskDeps, ownerReadGate, ownerRiskView, type RiskRouteDeps } from "./risk.routes";

export function createPositionsRoutes(getDeps: () => Promise<RiskRouteDeps> | RiskRouteDeps): RouteSpec[] {
  return [
    {
      method: "GET",
      path: "/positions",
      auth: "owner_sig",
      description: "Your open positions on each venue, each with its own liquidation price",
      async handler(c) {
        const q = PositionsQueryZ.safeParse(c.req.query());
        if (!q.success) return c.json(errorBody("INVALID_INPUT", q.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ")), 400);
        const deps = await getDeps();
        const owner = q.data.owner as Hex;
        const refused = await ownerReadGate(c, deps, owner);
        if (refused) return refused;
        const v = await ownerRiskView(owner, deps, q.data.venues as VenueId[] | undefined);
        return c.json({
          owner,
          venues: v.perVenue.map((s) => ({ venue: s.venue, identity: s.identity, positions: s.positions, asOf: s.asOf })),
          pending: v.pending,
          banner: BANNER,
          asOf: v.asOf,
        });
      },
    },
  ];
}

let resolved: Promise<RiskRouteDeps> | null = null;
export const routes: RouteSpec[] = createPositionsRoutes(() => (resolved ??= envRiskDeps()));
