// POST /v1/risk/ingest (spec 13.1): an Aster account read signed by the user's own agent key. Direct mode posts the
// venue's answer; relay mode posts only the signed query, which this host (same egress IP as the relay) sends to the
// venue byte for byte. The snapshot lands in the account store the risk view reads. Owner signature auth; at most
// 12 ingests per owner per minute.
import { ingestSignedRead, redisAccountStore, memoryAccountStore, defaultAsterReader, asterHttp, asterConfig, egressLabel, type AccountSnapshotStore, type DelegationLookup, type IngestBody, type IngestDeps } from "@capstan/adapter-aster";
import { createDb, createRedis, type RouteSpec } from "@capstan/core";
import { CapstanError, errorBody, type Hex } from "@capstan/schema";
import { createGovernor, createMemoryGovernor } from "@capstan/venue-client";
import type { Context } from "hono";

export const INGEST_LIMIT_PER_MIN = 12;

export interface RateLimiter {
  /** True when this hit is inside the limit. */
  hit(key: string, nowMs: number): Promise<boolean>;
}

export function memoryRateLimiter(limit = INGEST_LIMIT_PER_MIN, windowMs = 60_000): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    async hit(key, now) {
      const xs = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (xs.length >= limit) {
        hits.set(key, xs);
        return false;
      }
      xs.push(now);
      hits.set(key, xs);
      return true;
    },
  };
}

export function redisRateLimiter(redis: { incr(k: string): Promise<number>; pexpire(k: string, ms: number): Promise<number> }, limit = INGEST_LIMIT_PER_MIN): RateLimiter {
  return {
    async hit(key, now) {
      const k = `rl:risk-ingest:${key}:${Math.floor(now / 60_000)}`;
      const n = await redis.incr(k);
      if (n === 1) await redis.pexpire(k, 61_000);
      return n <= limit;
    },
  };
}

export interface RiskIngestDeps {
  ingest: Omit<IngestDeps, "now">;
  limiter: RateLimiter;
  now?: () => number;
}

/** Delegations table lookup: an active, unexpired Aster agent of this owner. */
export function dbDelegations(sql: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>): DelegationLookup {
  return {
    async isActive(owner, signer, nowMs) {
      const rows = (await sql`select 1 from delegations where venue = 'aster' and lower(owner) = ${owner.toLowerCase()} and lower(agent_address) = ${signer.toLowerCase()} and state = 'active' and (expires_at is null or expires_at > ${new Date(nowMs).toISOString()}::timestamptz) limit 1`) as unknown[];
      return rows.length > 0;
    },
  };
}

function ownerFromAuth(c: Context): string | null {
  const v = (c as unknown as { get(k: string): unknown }).get("owner");
  return typeof v === "string" ? v : null;
}

export function createRiskIngestRoutes(getDeps: () => Promise<RiskIngestDeps> | RiskIngestDeps): RouteSpec[] {
  return [
    {
      method: "POST",
      path: "/risk/ingest",
      auth: "owner_sig",
      description: "Ingest an Aster account read signed by your own agent key",
      async handler(c) {
        const deps = await getDeps();
        const now = (deps.now ?? Date.now)();
        let body: IngestBody;
        try {
          body = (await c.req.json()) as IngestBody;
        } catch {
          return c.json(errorBody("INVALID_INPUT", "body must be JSON"), 400);
        }
        const owner = body?.signedRead?.owner;
        if (typeof owner !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return c.json(errorBody("INVALID_INPUT", "signedRead.owner must be an address"), 400);
        const authed = ownerFromAuth(c);
        if (authed && authed.toLowerCase() !== owner.toLowerCase()) return c.json(errorBody("UNAUTHORIZED", "the signed owner does not match the read"), 401);
        if (!(await deps.limiter.hit(owner.toLowerCase(), now))) return c.json(errorBody("VENUE_RATE_LIMITED", "Too many account reads for this owner. Try again in a minute."), 429);
        try {
          const snapshot = await ingestSignedRead(body, { ...deps.ingest, now: () => now });
          return c.json({ ok: true, source: snapshot.source, asOf: snapshot.asOf, positions: snapshot.positions.length });
        } catch (e) {
          if (e instanceof CapstanError) return c.json(e.toBody(), e.status as 400);
          throw e;
        }
      },
    },
  ];
}

let resolved: Promise<RiskIngestDeps> | null = null;

/** Wiring from the environment (api role): Redis store and limiter, delegations from Postgres, the venue client. */
async function envDeps(): Promise<RiskIngestDeps> {
  const env = process.env;
  const network = env.CAPSTAN_ASTER_NETWORK === "Testnet" ? "Testnet" : "Mainnet";
  const cfg = asterConfig(network);
  const redis = env.REDIS_URL ? createRedis(env.REDIS_URL) : null;
  const store: AccountSnapshotStore = redis ? redisAccountStore(redis) : memoryAccountStore();
  const db = env.DATABASE_URL ? createDb(env.DATABASE_URL, { max: 2 }) : null;
  const delegations: DelegationLookup = db ? dbDelegations(db.$client as never) : { isActive: async () => false };
  const gov = redis ? createGovernor(redis, egressLabel(env)) : createMemoryGovernor(egressLabel(env));
  const reader = defaultAsterReader({ redis, network });
  const symbols = new Map<string, string>();
  return {
    ingest: {
      network,
      delegations,
      store,
      http: asterHttp(cfg, gov),
      marginAssetOf: (s) => {
        if (!symbols.size) void reader.listMarkets().then((ms) => ms.forEach((m) => symbols.set(m.venueSymbol, m.collateralAsset))).catch(() => undefined);
        return symbols.get(s) ?? null;
      },
    },
    limiter: redis ? redisRateLimiter(redis) : memoryRateLimiter(),
  };
}

export const routes: RouteSpec[] = createRiskIngestRoutes(() => (resolved ??= envDeps()));

export type { Hex };
