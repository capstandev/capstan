// Market data cache on Redis with the spec 2 TTLs. putBook and putMark also publish on the matching pub/sub channel in
// the same MULTI, so every ingest job feeds the WebSocket gateway with no publish code of its own.
import type { FundingSnapshot, OrderBook, VenueId } from "@capstan/schema";
import type { Redis } from "ioredis";

export const CACHE_TTL_MS = { book: 1000, mark: 1000, funding: 30000, meta: 600000 } as const; // spec 2 adapter rules

export const PUBSUB = {
  book: (id: string) => `ps:book:${id}`,
  mark: (id: string) => `ps:mark:${id}`,
  ticker: (a: string) => `ps:ticker:${a}`,
  funding: (a: string) => `ps:funding:${a}`,
  account: (o: string) => `ps:account:${o}`,
  risk: (o: string) => `ps:risk:${o}`,
  plan: (p: string) => `ps:plan:${p}`,
  receipts: (o: string) => `ps:receipts:${o}`,
};

export interface MarketDataCache {
  putBook(b: OrderBook): Promise<void>;
  getBook(id: string): Promise<OrderBook | null>;
  putFunding(f: FundingSnapshot): Promise<void>;
  getFunding(id: string): Promise<FundingSnapshot | null>;
  putMark(id: string, mark: string, asOf: string): Promise<void>;
  getMark(id: string): Promise<{ mark: string; asOf: string } | null>;
  putMeta(venue: VenueId, m: unknown): Promise<void>;
  getMeta?(venue: VenueId): Promise<unknown | null>;
}

const K = {
  book: (id: string) => `md:book:${id}`,
  mark: (id: string) => `md:mark:${id}`,
  funding: (id: string) => `md:funding:${id}`,
  meta: (v: string) => `md:meta:${v}`,
};

const parse = <T>(s: string | null): T | null => (s === null ? null : (JSON.parse(s) as T));

export function createMarketDataCache(redis: Redis, ttl: { book: number; mark: number; funding: number; meta: number } = CACHE_TTL_MS): MarketDataCache {
  return {
    async putBook(b) {
      const s = JSON.stringify(b);
      await redis.multi().set(K.book(b.marketId), s, "PX", ttl.book).publish(PUBSUB.book(b.marketId), s).exec();
    },
    async getBook(id) {
      return parse<OrderBook>(await redis.get(K.book(id)));
    },
    async putFunding(f) {
      await redis.set(K.funding(f.marketId), JSON.stringify(f), "PX", ttl.funding);
    },
    async getFunding(id) {
      return parse<FundingSnapshot>(await redis.get(K.funding(id)));
    },
    async putMark(id, mark, asOf) {
      const s = JSON.stringify({ marketId: id, mark, asOf });
      await redis.multi().set(K.mark(id), s, "PX", ttl.mark).publish(PUBSUB.mark(id), s).exec();
    },
    async getMark(id) {
      const v = parse<{ mark: string; asOf: string }>(await redis.get(K.mark(id)));
      return v ? { mark: v.mark, asOf: v.asOf } : null;
    },
    async putMeta(venue, m) {
      await redis.set(K.meta(venue), JSON.stringify(m), "PX", ttl.meta);
    },
    async getMeta(venue) {
      return parse<unknown>(await redis.get(K.meta(venue)));
    },
  };
}

/** In-process cache with the same contract (tests and single-process tools). Publishes to an optional callback. */
export function memoryMarketDataCache(onPublish?: (channel: string, payload: string) => void): MarketDataCache {
  const m = new Map<string, { v: string; exp: number }>();
  const put = (k: string, v: string, ms: number) => m.set(k, { v, exp: Date.now() + ms });
  const get = (k: string) => {
    const e = m.get(k);
    if (!e || e.exp <= Date.now()) return null;
    return e.v;
  };
  return {
    async putBook(b) {
      const s = JSON.stringify(b);
      put(K.book(b.marketId), s, CACHE_TTL_MS.book);
      onPublish?.(PUBSUB.book(b.marketId), s);
    },
    async getBook(id) {
      return parse<OrderBook>(get(K.book(id)));
    },
    async putFunding(f) {
      put(K.funding(f.marketId), JSON.stringify(f), CACHE_TTL_MS.funding);
    },
    async getFunding(id) {
      return parse<FundingSnapshot>(get(K.funding(id)));
    },
    async putMark(id, mark, asOf) {
      const s = JSON.stringify({ marketId: id, mark, asOf });
      put(K.mark(id), s, CACHE_TTL_MS.mark);
      onPublish?.(PUBSUB.mark(id), s);
    },
    async getMark(id) {
      const v = parse<{ mark: string; asOf: string }>(get(K.mark(id)));
      return v ? { mark: v.mark, asOf: v.asOf } : null;
    },
    async putMeta(venue, v) {
      put(K.meta(venue), JSON.stringify(v), CACHE_TTL_MS.meta);
    },
    async getMeta(venue) {
      return parse<unknown>(get(K.meta(venue)));
    },
  };
}
