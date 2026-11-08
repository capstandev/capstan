// GET /v1/eligibility?venue= (spec 13.1): whether an order on the venue would be allowed from the caller's IP,
// as { allowed, code, rulesVersion }. The IP is never echoed and never stored (the decision row keeps the country).
// `owner` is accepted for compatibility but not used (security review r1 ELIG-2): the answer is for the region, so it is
// DECLARATION_MISSING when the region is fine (a write still needs the owner's signed declaration). Nothing is stored.
// Free, public.
import { createDb, type Db, type RouteSpec } from "@capstan/core";
import { clientIp, decide, fileGeo, GEO_FILE, type GeoLookup } from "@capstan/eligibility";
import { CapstanError, errorBody, type VenueId, VENUE_IDS } from "@capstan/schema";
import type { Context } from "hono";
import { join } from "node:path";

export interface EligibilityRouteDeps {
  geo: GeoLookup;
  db: Db;
  now?: () => Date;
  ipOf?: (c: Context) => string | null;
}

export function createEligibilityRoutes(getDeps: () => Promise<EligibilityRouteDeps> | EligibilityRouteDeps): RouteSpec[] {
  return [
    {
      method: "GET",
      path: "/eligibility",
      auth: "public",
      description: "Whether orders on a venue are available from your region",
      async handler(c) {
        const venue = c.req.query("venue");
        if (!venue || !(VENUE_IDS as readonly string[]).includes(venue)) return c.json(errorBody("UNSUPPORTED_VENUE"), 400);
        const ownerQ = c.req.query("owner");
        if (ownerQ !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(ownerQ)) return c.json(errorBody("INVALID_INPUT", "owner must be an address"), 400);
        const deps = await getDeps();
        const ip = (deps.ipOf ?? ((x: Context) => clientIp(x, process.env.CAPSTAN_TRUST_FORWARDED_FOR === "1")))(c) ?? "";
        try {
          // r1 ELIG-2: the public probe answers for the region only (an unsigned ?owner= never reveals whether that
          // wallet holds a declaration) and writes no decision row
          const d = await decide({ ip, venue: venue as VenueId, action: "order", persist: false }, { geo: deps.geo, db: deps.db, now: deps.now ?? (() => new Date()) });
          return c.json({ allowed: d.allowed, code: d.code ?? null, rulesVersion: d.rulesVersion });
        } catch (e) {
          if (e instanceof CapstanError) return c.json(e.toBody(), e.status as 400);
          throw e;
        }
      },
    },
  ];
}

let resolved: Promise<EligibilityRouteDeps> | null = null;

/** Wiring from the environment: DATABASE_URL and the geo file the geo-db-refresh job keeps in CAPSTAN_GEO_DIR. */
async function envDeps(): Promise<EligibilityRouteDeps> {
  const env = process.env;
  if (!env.DATABASE_URL) throw new CapstanError("INTERNAL_ERROR", "DATABASE_URL is not set");
  return { db: createDb(env.DATABASE_URL, { max: 2 }), geo: fileGeo(join(env.CAPSTAN_GEO_DIR ?? "var/geo", GEO_FILE)) };
}

export const routes: RouteSpec[] = createEligibilityRoutes(() => (resolved ??= envDeps()));
