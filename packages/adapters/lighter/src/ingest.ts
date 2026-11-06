// WebSocket-first Lighter ingest for one config. Standard accounts get 60 REST requests per minute per IP, so books,
// marks and funding come from the public stream; REST is only for orderBookDetails (catalog, every 5 minutes) and
// backfill, always through the 1 req/s governor.
// Stream rules (docs, WebSocket): order_book/{i} sends a full snapshot on subscribe, then deltas (size 0 removes a
// level) whose begin_nonce must equal the previous nonce; a gap drops the local book and resubscribes. market_stats/all
// is one subscription for every market's mark, index and funding. Limits: 500 subscriptions per connection, 200
// client messages per minute per IP, so at most `maxBooks` book channels (default 150) per config.
import { Dec, type FundingSnapshot, type MarketEvent, type OrderBook, type Unsubscribe } from "@capstan/schema";
import { venueWs, type VenueWs, type VenueWsOptions } from "@capstan/venue-client";
import type { LighterConfig } from "./config";
import { fundingFraction } from "./read";

export const LIGHTER_WS_MAX_SUBS = 500;
export const LIGHTER_WS_DEFAULT_MAX_BOOKS = 150;
export const LIGHTER_WS_PING_MS = 60_000; // the server closes a socket that sends nothing for 2 minutes
export const BOOK_DEPTH = 20;

export function lighterWsOptions(onError?: (e: unknown) => void): VenueWsOptions {
  return {
    maxConns: 4,
    maxNewPerMin: 10,
    maxSubs: LIGHTER_WS_MAX_SUBS,
    pingMs: LIGHTER_WS_PING_MS,
    pingMessage: { type: "ping" },
    unsubscribeMessage: (m) => ({ type: "unsubscribe", channel: (m as { channel: string }).channel }),
    backoffBaseMs: 500,
    backoffMaxMs: 30_000,
    ...(onError ? { onError } : {}),
  };
}

type Level = { price: string; size: string };
interface BookMsg {
  type?: string;
  channel?: string;
  timestamp?: number;
  order_book?: { asks?: Level[]; bids?: Level[]; nonce?: number; begin_nonce?: number };
}
interface StatsMsg {
  type?: string;
  channel?: string;
  timestamp?: number;
  market_stats?: Record<string, LighterMarketStats> | LighterMarketStats;
}
export interface LighterMarketStats {
  market_id: number;
  symbol?: string;
  mark_price?: string;
  index_price?: string;
  open_interest?: string;
  current_funding_rate?: string;
  funding_rate?: string;
  funding_timestamp?: number;
}

/** Local order book kept from a snapshot plus deltas, with the nonce continuity check. */
export class LocalBook {
  private bids = new Map<string, string>();
  private asks = new Map<string, string>();
  private nonce: number | null = null;
  ready = false;
  gaps = 0;

  /** Returns false on a continuity gap (the caller resubscribes). */
  apply(msg: BookMsg): boolean {
    const ob = msg.order_book;
    if (!ob) return true;
    const snapshot = String(msg.type).startsWith("subscribed/");
    if (snapshot) {
      this.bids.clear();
      this.asks.clear();
      this.ready = true;
    } else {
      if (!this.ready) return true; // deltas before the snapshot are ignored
      if (this.nonce !== null && typeof ob.begin_nonce === "number" && ob.begin_nonce !== this.nonce) {
        this.gaps++;
        this.reset();
        return false;
      }
    }
    for (const l of ob.bids ?? []) set(this.bids, l);
    for (const l of ob.asks ?? []) set(this.asks, l);
    if (typeof ob.nonce === "number") this.nonce = ob.nonce;
    return true;
  }

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.nonce = null;
    this.ready = false;
  }

  top(marketId: string, depth: number, asOfMs: number): OrderBook {
    return {
      marketId,
      bids: sorted(this.bids, "desc").slice(0, depth),
      asks: sorted(this.asks, "asc").slice(0, depth),
      asOf: new Date(asOfMs).toISOString(),
      ...(this.nonce !== null ? { seq: this.nonce } : {}),
    };
  }
}

function set(m: Map<string, string>, l: Level): void {
  const sz = Dec.parse(l.size, 12, "down");
  if (Dec.isZero(sz)) m.delete(l.price);
  else m.set(l.price, l.size);
}

function sorted(m: Map<string, string>, order: "asc" | "desc"): [string, string][] {
  const rows = [...m.entries()].map(([p, s]) => ({ p, d: Dec.parse(p, 12, "half_even"), s }));
  rows.sort((a, b) => Dec.cmp(a.d, b.d) * (order === "asc" ? 1 : -1));
  return rows.map((r) => [r.p, r.s] as [string, string]);
}

/** market_stats to a funding snapshot. funding_rate is the last payment, current_funding_rate the estimate for the next. */
export function fundingFromStats(marketId: string, s: LighterMarketStats, nowMs: number, capPerHour: string | null = null): FundingSnapshot | null {
  if (s.funding_rate === undefined) return null;
  const perHour = fundingFraction(s.funding_rate);
  const lastMs = typeof s.funding_timestamp === "number" ? s.funding_timestamp : nowMs;
  return {
    marketId,
    ratePerInterval: s.funding_rate,
    intervalS: 3600,
    ratePerHour: perHour,
    rateAnnualised: Dec.toString(Dec.mul(Dec.parse(perHour, 12), Dec.parse("8760", 0), 8, "half_even")),
    predictedNext: s.current_funding_rate !== undefined ? fundingFraction(s.current_funding_rate) : null,
    nextSettlementAt: new Date((Math.floor(lastMs / 3_600_000) + 1) * 3_600_000).toISOString(),
    capPerHour,
    source: "venue",
    asOf: new Date(nowMs).toISOString(),
  };
}

export interface IngestMarket {
  id: string;
  index: number;
  capPerHour?: string | null;
}

export interface LighterIngest {
  /** Subscribe books (up to maxBooks) and the all-markets stats channel; events go to onEvent. */
  start(markets: IngestMarket[], onEvent: (e: MarketEvent) => void): Unsubscribe;
  stats(): { connections: number; subscriptions: number; books: number; gaps: number; maxSubsPerConn: number };
  close(): void;
}

export function createLighterIngest(
  cfg: Readonly<LighterConfig>,
  opts: { ws?: VenueWs; maxBooks?: number; now?: () => number; depth?: number; onError?: (e: unknown) => void } = {},
): LighterIngest {
  const ws = opts.ws ?? venueWs(cfg.governorKey, cfg.ws, lighterWsOptions(opts.onError));
  const now = opts.now ?? (() => Date.now());
  const maxBooks = Math.min(opts.maxBooks ?? LIGHTER_WS_DEFAULT_MAX_BOOKS, LIGHTER_WS_MAX_SUBS - 1);
  const depth = opts.depth ?? BOOK_DEPTH;
  const books = new Map<string, LocalBook>();
  let gapsTotal = 0;

  return {
    start(markets, onEvent) {
      const unsubs: Unsubscribe[] = [];
      const byIndex = new Map(markets.map((m) => [m.index, m]));
      for (const m of markets.slice(0, maxBooks)) {
        const channel = `order_book:${m.index}`;
        const book = new LocalBook();
        books.set(m.id, book);
        let un: Unsubscribe = () => undefined;
        const onMsg = (raw: unknown) => {
          const msg = raw as BookMsg;
          if (msg.channel !== channel) return;
          if (!book.apply(msg)) {
            gapsTotal++;
            un();
            un = ws.subscribe({ type: "subscribe", channel: `order_book/${m.index}` }, onMsg); // fresh snapshot
            return;
          }
          if (book.ready) onEvent({ kind: "book", book: book.top(m.id, depth, now()) });
        };
        un = ws.subscribe({ type: "subscribe", channel: `order_book/${m.index}` }, onMsg);
        unsubs.push(() => un());
      }
      unsubs.push(
        ws.subscribe({ type: "subscribe", channel: "market_stats/all" }, (raw) => {
          const msg = raw as StatsMsg;
          if (!String(msg.channel ?? "").startsWith("market_stats:")) return;
          const ms = msg.market_stats;
          if (!ms) return;
          const list: LighterMarketStats[] = typeof (ms as LighterMarketStats).market_id === "number" ? [ms as LighterMarketStats] : Object.values(ms as Record<string, LighterMarketStats>);
          const t = now();
          for (const s of list) {
            const m = byIndex.get(s.market_id);
            if (!m) continue;
            if (s.mark_price !== undefined) onEvent({ kind: "mark", marketId: m.id, mark: s.mark_price, ...(s.index_price !== undefined ? { index: s.index_price } : {}), asOf: new Date(t).toISOString() });
            const f = fundingFromStats(m.id, s, t, m.capPerHour ?? null);
            if (f) onEvent({ kind: "funding", funding: f });
          }
        }),
      );
      return () => {
        for (const u of unsubs) u();
        for (const m of markets) books.delete(m.id);
      };
    },
    stats() {
      const s = ws.stats();
      return { connections: s.connections, subscriptions: s.subscriptions, books: books.size, gaps: gapsTotal, maxSubsPerConn: LIGHTER_WS_MAX_SUBS };
    },
    close() {
      ws.close();
    },
  };
}
