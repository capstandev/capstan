// Variational read-only adapter: one public GET (/metadata/v2/stats) feeds markets, marks, funding and size-bucketed
// quotes. The CDN refreshes about every 30 to 60 s, so one snapshot is fetched at most once per POLL_MS and every
// read in between is served from it. The venue limit is 10 requests per 10 s per IP; the shared governor keeps this
// process under 80% of it, and a 429 body's retry_after_seconds sets the cool-off before the retry.
import type { MarketDataCache } from "@capstan/core";
import { CapstanError, type FundingSnapshot, type Market, type MarketEvent, type OrderBook, type Unsubscribe, type VenueCapabilities } from "@capstan/schema";
import { createGovernor, createMemoryGovernor, venueHttp, type Governor, type VenueHttp, type VenueHttpOptions } from "@capstan/venue-client";
import { VENUE_HOSTS } from "@capstan/schema";
import type { Redis } from "ioredis";
import { markOf, normalizeFunding, snapshotAsOf, normalizeMarket, quoteBuckets, tickerOf, type VariationalListing, type VariationalStats } from "./normalize";
import { dataOnlyCaps, dataOnlyMethods, type DataOnlyMethods, type QuoteBucket, type ReadOnlyAdapter } from "./readonly";

export const STATS_PATH = "/metadata/v2/stats";
/** Poll gap: the cache changes every 30 to 60 s, so a faster poll only spends budget. */
export const POLL_MS = 30_000;
/** Cross-check staleness limit for Variational marks (DECISIONS #29). */
export const VARIATIONAL_STALE_MS = 120_000;

export interface VariationalOptions {
  now?: () => number;
  /** Minimum gap between two stats fetches (default POLL_MS; tests lower it). */
  minGapMs?: number;
  /** Timer for streamMarket polling (tests inject a fake). */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

export interface VariationalSnapshot {
  fetchedAt: number;
  byId: Map<string, VariationalListing>;
  updatedAt: string;
  /** Newest quote updated_at in the payload: the asOf for a listing without quotes. */
  asOf: string;
}

export type VariationalAdapter = ReadOnlyAdapter &
  DataOnlyMethods & {
    readonly caps: VenueCapabilities;
    getQuoteBuckets(marketId: string): Promise<QuoteBucket[]>;
    getMark(marketId: string): Promise<{ mark: string; asOf: string } | null>;
    /** Every listing's mark and funding from one snapshot (the ingest job). */
    snapshot(force?: boolean): Promise<{ markets: Market[]; marks: { marketId: string; mark: string; asOf: string }[]; funding: FundingSnapshot[]; fetchedAt: number }>;
    /** Fetches made so far (tests and metrics). */
    fetches(): number;
  };

export function createVariationalAdapter(http: VenueHttp, cache: MarketDataCache | null, opts: VariationalOptions = {}): VariationalAdapter {
  const now = opts.now ?? Date.now;
  const minGap = opts.minGapMs ?? POLL_MS;
  let snap: VariationalSnapshot | null = null;
  let inflight: Promise<VariationalSnapshot> | null = null;
  let count = 0;

  async function load(force = false): Promise<VariationalSnapshot> {
    if (!force && snap && now() - snap.fetchedAt < minGap) return snap;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        count++;
        const s = await http.getJson<VariationalStats>(STATS_PATH, undefined, 1);
        if (!s || !Array.isArray(s.listings)) throw new CapstanError("VENUE_ERROR", "variational: stats has no listings");
        const byId = new Map<string, VariationalListing>();
        for (const l of s.listings) byId.set(normalizeMarket(l, "").id, l);
        const updatedAt = new Date(now()).toISOString();
        // no quote time anywhere: the payload is at least as old as the CDN cache allows
        const asOf = snapshotAsOf(s.listings) ?? new Date(now() - 60_000).toISOString();
        snap = { fetchedAt: now(), byId, updatedAt, asOf };
        if (cache) await cache.putMeta("variational", { markets: byId.size, at: snap.updatedAt });
        return snap;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function listing(id: string): Promise<VariationalListing> {
    tickerOf(id);
    const l = (await load()).byId.get(id);
    if (!l) throw new CapstanError("NOT_FOUND", `unknown Variational market ${id}`);
    return l;
  }

  const adapter: VariationalAdapter = {
    ...dataOnlyMethods("variational"),
    caps: dataOnlyCaps("variational"),

    async listMarkets() {
      const s = await load();
      return [...s.byId.values()].map((l) => normalizeMarket(l, s.updatedAt));
    },

    async getBook(): Promise<OrderBook | null> {
      return null; // no depth on Variational: size buckets only
    },

    async getFunding(id) {
      const f = normalizeFunding(await listing(id), (await load()).asOf);
      if (cache) await cache.putFunding(f);
      return f;
    },

    async getQuoteBuckets(id) {
      return quoteBuckets(await listing(id));
    },

    async getMark(id) {
      const l = (await load()).byId.get(id);
      if (!l) return null;
      const m = markOf(l, snap!.asOf);
      return { mark: m.mark, asOf: m.asOf };
    },

    async snapshot(force = false) {
      const s = await load(force);
      const ls = [...s.byId.values()];
      return { markets: ls.map((l) => normalizeMarket(l, s.updatedAt)), marks: ls.map((l) => markOf(l, s.asOf)), funding: ls.map((l) => normalizeFunding(l, s.asOf)), fetchedAt: s.fetchedAt };
    },

    streamMarket(ids, onEvent: (e: MarketEvent) => void): Unsubscribe {
      const wanted = new Set(ids);
      const seen = new Map<string, string>(); // marketId -> last asOf delivered
      const tick = async () => {
        try {
          const s = await load();
          for (const [id, l] of s.byId) {
            if (!wanted.has(id)) continue;
            const m = markOf(l, s.asOf);
            if (seen.get(id) === m.asOf) continue; // same CDN snapshot: nothing new
            seen.set(id, m.asOf);
            onEvent({ kind: "mark", marketId: id, mark: m.mark, asOf: m.asOf });
            onEvent({ kind: "funding", funding: normalizeFunding(l, s.asOf) });
          }
        } catch {
          // the next tick retries; the governor already holds back after a 429
        }
      };
      const si = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
      const ci = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
      void tick();
      const h = si(() => void tick(), minGap);
      return () => ci(h);
    },

    fetches: () => count,
  };
  return adapter;
}

/** The governed client for Variational (budget shared per egress IP through Redis when given). */
export function variationalHttp(gov: Governor, opts: VenueHttpOptions = {}, baseUrl: string = VENUE_HOSTS.variational.rest): VenueHttp {
  return venueHttp("variational", baseUrl, gov, { userAgent: "capstan-variational", ...opts });
}

/** Adapter wired from the environment: Redis governor when a client is given, else an in-process one. */
export function defaultVariationalAdapter(o: { redis?: Redis | null; cache?: MarketDataCache | null; env?: Record<string, string | undefined> } = {}): VariationalAdapter {
  const env = o.env ?? process.env;
  const egress = env.RELAY_EGRESS_IP?.trim() || "local";
  const gov = o.redis ? createGovernor(o.redis, egress) : createMemoryGovernor(egress);
  return createVariationalAdapter(variationalHttp(gov), o.cache ?? null);
}
