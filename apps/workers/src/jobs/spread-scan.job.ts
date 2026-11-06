// spread-scan, every 60 s (spec 9 spread-planner scan): ranks funding-rate spread trades (at-risk) for every asset
// with an approved equivalence and caches the rows at md:scan:<asset> (and md:scan:all) for 90 s, so the paid route
// answers from cache. Rows are observed, changes hourly. A pair whose markets changed since approval is dropped and an
// ops event is raised. It never places anything.
import { createMarketDataCache, type Db, type JobDef, type JobDeps, type MarketDataCache, type Redis } from "@capstan/core";
import { cachedDepegReader, type QuoteAdapter } from "@capstan/quote";
import { dbSpreadCatalog, scan, type ScanDeps, type ScanRow } from "@capstan/spreads";
import type { CanonicalAsset, VenueId } from "@capstan/schema";
import { emitOpsEvent } from "@capstan/telemetry";

export const SCAN_TTL_MS = 90_000;
export const SCAN_DEFAULTS = { sizeUsd: "10000", leverage: 3 } as const;
export const scanKey = (asset: CanonicalAsset | "all") => `md:scan:${asset}`;

export interface ScanKv {
  put(key: string, value: string, ttlMs: number): Promise<void>;
}

export async function runSpreadScan(d: { deps: ScanDeps; kv: ScanKv }): Promise<{ assets: number; rows: number }> {
  const eqs = (await d.deps.catalog.equivalences()).filter((e) => e.status === "approved");
  const assets = [...new Set(eqs.map((e) => e.canonicalAsset as CanonicalAsset))].sort();
  const all: ScanRow[] = [];
  for (const asset of assets) {
    const rows = await scan({ asset, ...SCAN_DEFAULTS }, d.deps);
    await d.kv.put(scanKey(asset), JSON.stringify({ rows, asOf: d.deps.now().toISOString() }), SCAN_TTL_MS);
    all.push(...rows);
  }
  all.sort((a, b) => (a.breakevenHours ?? Number.POSITIVE_INFINITY) - (b.breakevenHours ?? Number.POSITIVE_INFINITY));
  await d.kv.put(scanKey("all"), JSON.stringify({ rows: all, asOf: d.deps.now().toISOString() }), SCAN_TTL_MS);
  return { assets: assets.length, rows: all.length };
}

/** Market-data adapters for the quote engine: books and funding come from the shared cache the ingest jobs fill. */
export function cacheQuoteAdapters(cache: MarketDataCache): Map<VenueId, QuoteAdapter> {
  const m = new Map<VenueId, QuoteAdapter>();
  for (const v of ["hyperliquid", "lighter-mainnet", "lighter-rh", "aster"] as VenueId[]) {
    m.set(v, {
      caps: { venue: v, execution: true, keyType: v.startsWith("lighter") ? "lighter-native" : "secp256k1", delegation: v.startsWith("lighter") ? "api_key_index" : "agent", canWithdraw: false, builderFee: null, collateral: [], directSubmitSupported: true, publicAccountReads: v !== "aster" },
      getBook: async (id: string) => {
        const b = await cache.getBook(id);
        if (!b) throw new Error(`no cached book for ${id}`);
        return b;
      },
      getFunding: async (id: string) => {
        const f = await cache.getFunding(id);
        if (!f) throw new Error(`no cached funding for ${id}`);
        return f;
      },
    });
  }
  return m;
}

export function scanDepsFrom(db: Db, redis: Redis, cache: MarketDataCache, now: () => Date): ScanDeps {
  return {
    catalog: dbSpreadCatalog(db),
    quote: { adapters: cacheQuoteAdapters(cache), cache, depeg: cachedDepegReader(redis) },
    funding: { get: (id) => cache.getFunding(id) },
    now,
    eqExecutionAllowed: process.env.EQ_EXECUTION_ALLOWED === "1" || process.env.EQ_EXECUTION_ALLOWED === "true",
    alert: async (x) => {
      await emitOpsEvent(redis as never, { kind: "spreads.market_changed", severity: "warn", detail: x });
    },
  };
}

export const job: JobDef = {
  name: "spread-scan",
  queue: "spreadScan",
  schedule: { every: 60_000 },
  concurrency: 1,
  async handler(_j, deps: JobDeps) {
    if (!deps.db || !deps.redis) throw new Error("spread-scan needs a database and Redis");
    const redis = deps.redis;
    const cache = deps.cache ?? createMarketDataCache(redis);
    const r = await runSpreadScan({ deps: scanDepsFrom(deps.db, redis, cache, deps.now), kv: { put: async (k, v, ttl) => void (await redis.set(k, v, "PX", ttl)) } });
    deps.log.info("spread-scan", r);
    return r;
  },
};
