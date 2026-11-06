// Arcus read-only adapter (public GETs only). Arcus answers 429 with a Retry-After header and sends no X-RateLimit
// headers, so weight is counted here: markets/prices/fundingRates 20 + floor(items / 20), bbo 2, l2OrderBook
// 2 + floor(nLevels / 20) (docs.arcus.xyz/api-reference/rate-limits, read 2026-11-05: charged on the depth asked for).
// Besides the shared per-IP governor (1,500 weight per minute, 80% ceiling), this adapter keeps itself under
// ARCUS_WEIGHT_PER_S (10 weight per second, averaged over a 10 s window) so data reads never crowd anything else out.
// Execution is T2: no key path, no session key, no referral rail exists here. Capstan never collects or relays KYC.
import type { MarketDataCache } from "@capstan/core";
import { CapstanError, VENUE_HOSTS, type FundingSnapshot, type Market, type MarketEvent, type OrderBook, type Unsubscribe, type VenueCapabilities } from "@capstan/schema";
import { arcusWeight, createGovernor, createMemoryGovernor, venueHttp, type Governor, type VenueHttp, type VenueHttpOptions } from "@capstan/venue-client";
import type { Redis } from "ioredis";
import { displayNameOf, markOf, normalizeBook, normalizeFunding, normalizeMarket, type ArcusBbo, type ArcusBook, type ArcusMarket, type ArcusMarkets } from "./normalize";
import { dataOnlyCaps, dataOnlyMethods, type DataOnlyMethods, type ReadOnlyAdapter } from "./readonly";

export type ArcusRest = "https://api.arcus.xyz" | "https://api.testnet.arcus.xyz";
export interface ArcusConfig {
  rest: ArcusRest;
  ws: string;
}
export const ARCUS_MAINNET: ArcusConfig = { rest: VENUE_HOSTS.arcus.rest, ws: VENUE_HOSTS.arcus.ws };
export const ARCUS_TESTNET: ArcusConfig = { rest: VENUE_HOSTS.arcusTestnet.rest, ws: VENUE_HOSTS.arcusTestnet.ws };

/** Weight per second this adapter allows itself, averaged over ARCUS_WEIGHT_WINDOW_MS. */
export const ARCUS_WEIGHT_PER_S = 10;
export const ARCUS_WEIGHT_WINDOW_MS = 10_000;
/** Markets poll gap (spec: GET /v1/markets every 10 s). */
export const ARCUS_POLL_MS = 10_000;
/** Book depth asked for on every l2OrderBook read (the docs example; the venue answered 20 levels with no nLevels). */
export const ARCUS_BOOK_LEVELS = 20;
/** Items assumed before the first markets answer tells the real count (81 on 2026-11-05). */
export const ARCUS_ASSUMED_ITEMS = 100;

/**
 * Venue metadata for the eligibility rules. Arcus "is not available in the U.S., Canada, United Kingdom and
 * other restricted jurisdictions" (docs disclaimer, read 2026-11-05). The full Terms list is not read yet.
 * There is deliberately no KYC field anywhere in this adapter: Capstan never collects or relays KYC.
 */
export const ARCUS_METADATA = {
  venue: "arcus",
  restrictedRegions: ["US", "CA", "GB"] as const,
  restrictedOthers: true,
  restrictionSource: "docs.arcus.xyz disclaimer and arcus.xyz/legal/terms, read 2026-11-05 (Terms list still to read)",
  execution: "T2: data only in v1",
} as const;

export interface ArcusOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minGapMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

export type ArcusAdapter = ReadOnlyAdapter &
  DataOnlyMethods & {
    readonly caps: VenueCapabilities;
    readonly metadata: typeof ARCUS_METADATA;
    getMark(marketId: string): Promise<{ mark: string; asOf: string } | null>;
    getBbo(marketId: string): Promise<ArcusBbo>;
    snapshot(force?: boolean): Promise<{ markets: Market[]; marks: NonNullable<ReturnType<typeof markOf>>[]; funding: FundingSnapshot[]; fetchedAt: number }>;
    /** Weight this adapter charged in the last window (tests and metrics). */
    weightUsed(): number;
    weightLog(): { at: number; cost: number }[];
  };

/** A sliding-window weight budget on the adapter's own clock. */
export function weightBudget(perSecond: number, windowMs: number, now: () => number, sleep: (ms: number) => Promise<void>) {
  const cap = (perSecond * windowMs) / 1000;
  const log: { at: number; cost: number }[] = [];
  const used = () => {
    const t = now();
    return log.filter((e) => e.at > t - windowMs).reduce((a, e) => a + e.cost, 0);
  };
  let chain: Promise<void> = Promise.resolve();
  return {
    log,
    used,
    acquire(cost: number): Promise<void> {
      if (cost > cap) throw new CapstanError("VENUE_RATE_LIMITED", `arcus: cost ${cost} is above the ${cap} window budget`);
      const p = chain.then(async () => {
        for (;;) {
          const t = now();
          const live = log.filter((e) => e.at > t - windowMs);
          const sum = live.reduce((a, e) => a + e.cost, 0);
          if (sum + cost <= cap) {
            log.push({ at: t, cost });
            while (log.length && log[0]!.at <= t - windowMs * 6) log.shift();
            return;
          }
          // wait until enough of the oldest entries leave the window
          let left = sum;
          let wait = windowMs;
          for (const e of live) {
            left -= e.cost;
            if (left + cost <= cap) {
              wait = e.at + windowMs - t + 1;
              break;
            }
          }
          await sleep(Math.max(1, wait));
        }
      });
      chain = p.catch(() => undefined);
      return p;
    },
  };
}

export function createArcusAdapter(cfg: ArcusConfig, http: VenueHttp, cache: MarketDataCache | null, opts: ArcusOptions = {}): ArcusAdapter {
  if (cfg.rest !== ARCUS_MAINNET.rest && cfg.rest !== ARCUS_TESTNET.rest) throw new Error(`arcus: unknown REST host ${cfg.rest}`);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const minGap = opts.minGapMs ?? ARCUS_POLL_MS;
  const budget = weightBudget(ARCUS_WEIGHT_PER_S, ARCUS_WEIGHT_WINDOW_MS, now, sleep);
  let lastItems = ARCUS_ASSUMED_ITEMS;
  let snap: { fetchedAt: number; byId: Map<string, ArcusMarket> } | null = null;
  let inflight: Promise<{ fetchedAt: number; byId: Map<string, ArcusMarket> }> | null = null;

  async function get<T>(path: string, items = 0, q?: Record<string, string | number>): Promise<T> {
    const cost = arcusWeight(path, items);
    await budget.acquire(cost);
    return http.getJson<T>(path, q, cost);
  }

  async function load(force = false) {
    if (!force && snap && now() - snap.fetchedAt < minGap) return snap;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const r = await get<ArcusMarkets>("/v1/markets", lastItems);
        if (!r || !Array.isArray(r.markets)) throw new CapstanError("VENUE_ERROR", "arcus: markets has no list");
        lastItems = r.markets.length;
        const byId = new Map(r.markets.map((m) => [normalizeMarket(m, "").id, m] as const));
        snap = { fetchedAt: now(), byId };
        if (cache) await cache.putMeta("arcus", { markets: byId.size, at: new Date(snap.fetchedAt).toISOString() });
        return snap;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function market(id: string): Promise<ArcusMarket> {
    displayNameOf(id);
    const m = (await load()).byId.get(id);
    if (!m) throw new CapstanError("NOT_FOUND", `unknown Arcus market ${id}`);
    return m;
  }

  const adapter: ArcusAdapter = {
    ...dataOnlyMethods("arcus"),
    caps: dataOnlyCaps("arcus"),
    metadata: ARCUS_METADATA,

    async listMarkets() {
      const s = await load();
      const iso = new Date(s.fetchedAt).toISOString();
      return [...s.byId.values()].map((m) => normalizeMarket(m, iso));
    },

    async getBook(id): Promise<OrderBook | null> {
      const name = displayNameOf(id);
      // weight 2 + floor(nLevels / 20) = 3: the per-level charge rides on the item count
      const b = await get<ArcusBook>(`/v1/l2OrderBook/${encodeURIComponent(name)}`, ARCUS_BOOK_LEVELS, { nLevels: ARCUS_BOOK_LEVELS });
      const book = normalizeBook(id, b, now());
      if (cache) await cache.putBook(book);
      return book;
    },

    async getBbo(id) {
      return get<ArcusBbo>(`/v1/bbo/${encodeURIComponent(displayNameOf(id))}`);
    },

    async getFunding(id) {
      const s = await load();
      const m = await market(id);
      const f = normalizeFunding(m, s.fetchedAt);
      if (!f) throw new CapstanError("NOT_FOUND", `arcus: no funding for ${id}`);
      if (cache) await cache.putFunding(f);
      return f;
    },

    async getMark(id) {
      const s = await load();
      const m = s.byId.get(id);
      const k = m ? markOf(m, s.fetchedAt) : null;
      return k ? { mark: k.mark, asOf: k.asOf } : null;
    },

    async snapshot(force = false) {
      const s = await load(force);
      const iso = new Date(s.fetchedAt).toISOString();
      const ms = [...s.byId.values()];
      return {
        markets: ms.map((m) => normalizeMarket(m, iso)),
        marks: ms.map((m) => markOf(m, s.fetchedAt)).filter((x): x is NonNullable<typeof x> => x !== null),
        funding: ms.map((m) => normalizeFunding(m, s.fetchedAt)).filter((x): x is FundingSnapshot => x !== null),
        fetchedAt: s.fetchedAt,
      };
    },

    streamMarket(ids, onEvent: (e: MarketEvent) => void): Unsubscribe {
      // REST polling of /v1/markets (about 2.4 weight per second); the markets WS channel can replace it later
      const wanted = new Set(ids);
      const tick = async () => {
        try {
          const s = await load();
          for (const [id, m] of s.byId) {
            if (!wanted.has(id)) continue;
            const k = markOf(m, s.fetchedAt);
            if (k) onEvent({ kind: "mark", marketId: id, mark: k.mark, ...(k.index ? { index: k.index } : {}), asOf: k.asOf });
            const f = normalizeFunding(m, s.fetchedAt);
            if (f) onEvent({ kind: "funding", funding: f });
          }
        } catch {
          // next tick retries
        }
      };
      const si = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
      const ci = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
      void tick();
      const h = si(() => void tick(), minGap);
      return () => ci(h);
    },

    weightUsed: () => budget.used(),
    weightLog: () => [...budget.log],
  };
  return adapter;
}

export function arcusHttp(cfg: ArcusConfig, gov: Governor, opts: VenueHttpOptions = {}): VenueHttp {
  return venueHttp(cfg.rest === ARCUS_TESTNET.rest ? "arcus-testnet" : "arcus", cfg.rest, gov, { userAgent: "capstan-arcus", ...opts });
}

export function defaultArcusAdapter(o: { redis?: Redis | null; cache?: MarketDataCache | null; env?: Record<string, string | undefined> } = {}): ArcusAdapter {
  const env = o.env ?? process.env;
  const cfg = env.CAPSTAN_ARCUS_NETWORK === "Testnet" ? ARCUS_TESTNET : ARCUS_MAINNET;
  const egress = env.RELAY_EGRESS_IP?.trim() || "local";
  const gov = o.redis ? createGovernor(o.redis, egress) : createMemoryGovernor(egress);
  return createArcusAdapter(cfg, arcusHttp(cfg, gov), o.cache ?? null);
}
