// Country lookup for the eligibility re-check: the DB-IP Lite file the geo-db-refresh job keeps in CAPSTAN_GEO_DIR.
// A missing file answers null for every IP, so opening orders are refused until a good file is in place.
import { fileGeo, GEO_FILE, type GeoLookup } from "@capstan/eligibility";
import { join } from "node:path";

export async function getGeoLookup(env: Record<string, string | undefined>): Promise<GeoLookup> {
  return fileGeo(join(env.CAPSTAN_GEO_DIR ?? "var/geo", GEO_FILE));
}
