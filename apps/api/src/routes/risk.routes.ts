// Risk routes (spec 13.1, E3). Every answer keeps each venue's account as its own entry under the fixed banner.
// GET  /v1/risk?owner=            owner-signed read (purpose 'read'); nothing is public without the signature
// POST /v1/risk/snapshot          x402 $0.01: third-party addresses, public venue reads only, Aster excluded
// GET  /v1/risk/liq-heatmap?asset= x402 $0.02: from public HL and Lighter account samples already read; no identifiers
import { createDb, createMarketDataCache, createRedis, memoryNonceStore, redisNonceStore, schema, type NonceStore, type RouteSpec } from "@capstan/core";
import { dbCatalogReader } from "@capstan/quote";
import { buildRiskView, BANNER, cacheMarks, dbIdentities, envAccountDeps, liqHeatmap, marketIdsOf, ownerView, readAccountsDetailed, samplesFromViews, verifyOwnerRead, type CapstanRiskView, type OwnerViewDeps } from "@capstan/risk";
import { errorBody, LiqHeatmapQueryZ, RiskQueryZ, RiskSnapshotZ, type CanonicalAsset, type Hex, type VenueId, type VenueIdentity } from "@capstan/schema";
import { desc, gte } from "drizzle-orm";
import type { Context } from "hono";

export const RISK_PRICES = { snapshot: "0.01", heatmap: "0.02" } as const;
export const HEATMAP_WINDOW_MS = 15 * 60_000;

export interface RiskRouteDeps extends OwnerViewDeps {
  recentViews(sinceMs: number): Promise<Pick<CapstanRiskView, "perVenue">[]>;
  nonces: NonceStore;
  host: string;
  now?: () => number;
}

/** Path and query exactly as received, for the signed body hash. */
export function pathWithQuery(c: Context): string {
  const u = new URL(c.req.url);
  return `${u.pathname}${u.search}`;
}

export async function ownerReadGate(c: Context, deps: Pick<RiskRouteDeps, "nonces" | "host" | "now">, owner: Hex): Promise<Response | null> {
  const r = await verifyOwnerRead(c.req.raw.headers, { owner, method: c.req.method, pathWithQuery: pathWithQuery(c), host: deps.host, nowMs: (deps.now ?? Date.now)() }, deps.nonces);
  if (r.ok) return null;
  return c.json(errorBody("UNAUTHORIZED", `Sign this read with your wallet (purpose read, at most 5 minutes; ${r.reason}).`), 401);
}

export const ownerRiskView = (owner: Hex, deps: RiskRouteDeps, venues?: VenueId[]): Promise<CapstanRiskView> => ownerView(owner, deps, venues);

const bad = (c: Context, issues: { path: PropertyKey[]; message: string }[]) => c.json(errorBody("INVALID_INPUT", issues.map((i) => `${i.path.map(String).join(".") || "request"}: ${i.message}`).join("; ")), 400);

export function createRiskRoutes(getDeps: () => Promise<RiskRouteDeps> | RiskRouteDeps): RouteSpec[] {
  return [
    {
      method: "GET",
      path: "/risk",
      auth: "owner_sig",
      description: "Your risk view: every venue's account and liquidation price on its own",
      async handler(c) {
        const q = RiskQueryZ.safeParse(c.req.query());
        if (!q.success) return bad(c, q.error.issues);
        const deps = await getDeps();
        const owner = q.data.owner as Hex;
        const refused = await ownerReadGate(c, deps, owner);
        if (refused) return refused;
        return c.json(await ownerRiskView(owner, deps));
      },
    },
    {
      method: "POST",
      path: "/risk/snapshot",
      auth: "x402",
      priced: { usd: RISK_PRICES.snapshot },
      description: "Risk snapshot for any addresses from public venue reads (Aster needs the owner's own signed read)",
      async handler(c) {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json(errorBody("INVALID_INPUT", "body must be JSON"), 400);
        }
        const p = RiskSnapshotZ.safeParse(body);
        if (!p.success) return bad(c, p.error.issues);
        const deps = await getDeps();
        const ids = p.data.addresses.map((a) => ({ venue: a.venue, owner: a.owner as Hex, ...(a.accountIndex !== undefined ? { accountIndex: a.accountIndex } : {}) })) as VenueIdentity[];
        const pub = ids.filter((i) => i.venue !== "aster");
        // third-party reads: public venue reads only, never an ingested Aster read of someone else
        const { snapshots, pending } = await readAccountsDetailed(pub, { ...deps.accounts, asterIngested: async () => null });
        for (const i of ids) if (i.venue === "aster") pending.push({ venue: "aster", identity: i, status: "excluded", reason: "Aster accounts are not public: only the owner's own signed read shows them." });
        const marks = await deps.marks(marketIdsOf(snapshots));
        return c.json(await buildRiskView(null, ids, snapshots, marks, deps.catalog, new Date((deps.now ?? Date.now)()), { pending }));
      },
    },
    {
      method: "GET",
      path: "/risk/liq-heatmap",
      auth: "x402",
      priced: { usd: RISK_PRICES.heatmap },
      description: "Liquidation heatmap per venue for one asset, from public account samples",
      async handler(c) {
        const q = LiqHeatmapQueryZ.safeParse(c.req.query());
        if (!q.success) return bad(c, q.error.issues);
        const deps = await getDeps();
        const views = await deps.recentViews((deps.now ?? Date.now)() - HEATMAP_WINDOW_MS);
        const h = liqHeatmap(q.data.asset as CanonicalAsset, samplesFromViews(views as never, q.data.asset as CanonicalAsset));
        return c.json({ ...h, banner: BANNER });
      },
    },
  ];
}

let resolved: Promise<RiskRouteDeps> | null = null;

/** Keyless HL and Lighter account readers on the shared governor (free priority); Aster from ingested reads only. */
export async function envRiskDeps(env: Record<string, string | undefined> = process.env): Promise<RiskRouteDeps> {
  const redis = env.REDIS_URL ? createRedis(env.REDIS_URL) : null;
  const cache = redis ? createMarketDataCache(redis) : null;
  const db = env.DATABASE_URL ? createDb(env.DATABASE_URL, { max: 4 }) : null;
  const accounts = await envAccountDeps(env, { redis, cache });
  return {
    identities: db ? dbIdentities(db) : async () => [],
    accounts,
    catalog: db ? dbCatalogReader(db) : { marketsByIds: async () => [], marketsForAsset: async () => [] },
    marks: cache ? cacheMarks(cache) : async () => new Map(),
    recentViews: db ? async (since) => (await db.select().from(schema.riskSnapshots).where(gte(schema.riskSnapshots.ts, new Date(since))).orderBy(desc(schema.riskSnapshots.ts)).limit(2000)).map((r) => r.view as CapstanRiskView) : async () => [],
    nonces: redis ? redisNonceStore(redis) : memoryNonceStore(),
    host: env.PUBLIC_API_HOST ?? "localhost:8710",
  };
}

export const routes: RouteSpec[] = createRiskRoutes(() => (resolved ??= envRiskDeps()));
