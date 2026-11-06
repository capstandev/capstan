// GET /v1/spreads/scan?asset=&minHours= (spec 13.1, E4; x402 $0.02): funding-rate spread trades (at-risk) over
// approved equivalences only. Rows come from the 60 s scan cache (md:scan:<asset>), else a live scan. Every row says
// "At-risk. Legging risk is yours." and the funding difference is observed and changes hourly. minHours keeps rows that
// break even within that many hours.
import { createDb, createMarketDataCache, createRedis, type RouteSpec } from "@capstan/core";
import { cachedDepegReader, type QuoteAdapter } from "@capstan/quote";
import { dbSpreadCatalog, OBSERVED_NOTE, scan, type ScanRequest, type ScanRow } from "@capstan/spreads";
import { errorBody, SPREAD_RISK_LABEL, SpreadScanQueryZ, type CanonicalAsset, type VenueId } from "@capstan/schema";

export const SPREAD_SCAN_PRICE = "0.02";
export const SCAN_DEFAULTS = { sizeUsd: "10000", leverage: 3 } as const;

export interface SpreadScanRouteDeps {
  cached(asset: CanonicalAsset | "all"): Promise<{ rows: ScanRow[]; asOf: string } | null>;
  live(req: ScanRequest): Promise<ScanRow[]>;
  now?: () => number;
}

export function createSpreadScanRoutes(getDeps: () => Promise<SpreadScanRouteDeps> | SpreadScanRouteDeps): RouteSpec[] {
  return [
    {
      method: "GET",
      path: "/spreads/scan",
      auth: "x402",
      priced: { usd: SPREAD_SCAN_PRICE },
      description: "Funding-rate spread trades (at-risk) across reviewed equivalent markets, with cost, breakeven and both liquidation prices",
      async handler(c) {
        const q = SpreadScanQueryZ.safeParse(c.req.query());
        if (!q.success) return c.json(errorBody("INVALID_INPUT", q.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ")), 400);
        const deps = await getDeps();
        const asset = q.data.asset as CanonicalAsset | undefined;
        const hit = await deps.cached(asset ?? "all").catch(() => null);
        let rows: ScanRow[];
        let source: "cache" | "live";
        let asOf: string;
        if (hit) {
          rows = hit.rows;
          source = "cache";
          asOf = hit.asOf;
        } else {
          rows = await deps.live({ ...(asset ? { asset } : {}), ...SCAN_DEFAULTS });
          source = "live";
          asOf = new Date((deps.now ?? Date.now)()).toISOString();
        }
        if (q.data.minHours !== undefined) rows = rows.filter((r) => r.breakevenHours !== null && r.breakevenHours <= q.data.minHours!);
        return c.json({ rows, riskLabel: SPREAD_RISK_LABEL, observedNote: OBSERVED_NOTE, sizeUsd: SCAN_DEFAULTS.sizeUsd, leverage: SCAN_DEFAULTS.leverage, source, asOf });
      },
    },
  ];
}

let resolved: Promise<SpreadScanRouteDeps> | null = null;

async function envDeps(): Promise<SpreadScanRouteDeps> {
  const env = process.env;
  if (!env.REDIS_URL || !env.DATABASE_URL) throw new Error("the spread scan needs REDIS_URL and DATABASE_URL");
  const redis = createRedis(env.REDIS_URL);
  const cache = createMarketDataCache(redis);
  const db = createDb(env.DATABASE_URL, { max: 2 });
  const adapters = new Map<VenueId, QuoteAdapter>();
  for (const v of ["hyperliquid", "lighter-mainnet", "lighter-rh", "aster"] as VenueId[])
    adapters.set(v, {
      caps: { venue: v, execution: true, keyType: v.startsWith("lighter") ? "lighter-native" : "secp256k1", delegation: v.startsWith("lighter") ? "api_key_index" : "agent", canWithdraw: false, builderFee: null, collateral: [], directSubmitSupported: true, publicAccountReads: v !== "aster" },
      getBook: async (id: string) => (await cache.getBook(id)) ?? Promise.reject(new Error(`no cached book for ${id}`)),
      getFunding: async (id: string) => (await cache.getFunding(id)) ?? Promise.reject(new Error(`no cached funding for ${id}`)),
    });
  return {
    cached: async (a) => {
      const v = await redis.get(`md:scan:${a}`);
      return v ? (JSON.parse(v) as { rows: ScanRow[]; asOf: string }) : null;
    },
    live: (req) => scan(req, { catalog: dbSpreadCatalog(db), quote: { adapters, cache, depeg: cachedDepegReader(redis) }, funding: { get: (id) => cache.getFunding(id) }, now: () => new Date(), eqExecutionAllowed: env.EQ_EXECUTION_ALLOWED === "1" || env.EQ_EXECUTION_ALLOWED === "true" }),
  };
}

export const routes: RouteSpec[] = createSpreadScanRoutes(() => (resolved ??= envDeps()));
