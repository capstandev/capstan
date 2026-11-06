// Aster public market-data reader (fapi V3, unsigned GETs only). Costs follow the measured weights in
// venue-aster.md section 2 and are passed to the governor explicitly. The funding-interval table (fundingInfo, weight
// 10) is fetched at most once per minute and is never trusted for longer than one hour, because the venue changes
// intervals per market without notice (PTBUSDT moved 1 h -> 4 h).
import type { MarketDataCache } from "@capstan/core";
import { CapstanError, venueNetwork, type FundingSnapshot, type Market, type MarketEvent, type OrderBook, type Unsubscribe } from "@capstan/schema";
import { asterWeight, createGovernor, createMemoryGovernor, isUnknownOutcome, venueHttp, venueWs, type Governor, type VenueHttp, type VenueHttpOptions, type VenueWs } from "@capstan/venue-client";
import type { Redis } from "ioredis";
import { asterConfig, assertV3Path, validateAsterConfig, type AsterConfig, type AsterNetwork } from "./config";
import {
  depthStream,
  fundingIntervalsFrom,
  MARK_ARR_STREAM,
  normalizeBook,
  normalizeFunding,
  normalizeMarket,
  symbolOf,
  wsEvents,
  type AsterDepth,
  type AsterExchangeInfo,
  type AsterFundingInfoRow,
  type AsterMarket,
  type AsterPremiumIndex,
  type FundingInterval,
} from "./normalize";

export const DEPTH_LIMITS = [5, 10, 20, 50, 100, 500, 1000] as const;
export type DepthLimit = (typeof DEPTH_LIMITS)[number];
/** fundingInfo is called at most once per this window (it costs 10 weight). */
export const FUNDING_INFO_MIN_GAP_MS = 60_000;
/** The interval table is never used when older than this. */
export const FUNDING_INFO_MAX_AGE_MS = 3_600_000;
/** Streams per SUBSCRIBE message (and per connection). */
export const WS_STREAMS_PER_CONN = 100;

export interface AsterReader {
  listMarkets(): Promise<AsterMarket[]>;
  getBook(marketId: string, depth?: number): Promise<OrderBook>;
  getFunding(marketId: string): Promise<FundingSnapshot>;
  /** Every market's interval; one fundingInfo call per minute at most. */
  fundingIntervals(): Promise<Record<string, FundingInterval>>;
  /** One no-symbol premiumIndex call (weight 10): every market's funding snapshot. */
  allFunding(): Promise<FundingSnapshot[]>;
  /** Depth for `marketIds`; marks and funding for them, or for every symbol with `allMarks` (the ingest). */
  streamMarket(marketIds: string[], onEvent: (e: MarketEvent) => void, opts?: { allMarks?: boolean }): Unsubscribe;
  /** Age in ms of the interval table, or null if never fetched. */
  intervalsAgeMs(): number | null;
}

export interface AsterReaderOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Tries for a read answered 503 (status unknown). Default 3. */
  unknownTries?: number;
  backoffBaseMs?: number;
  /** WebSocket factory (tests inject a fake). */
  ws?: (url: string) => VenueWs;
}

/** A read the venue answered 503 to every time: the data is unknown, not absent. */
export class AsterUnknownError extends CapstanError {
  readonly outcome = "unknown" as const;
  readonly path: string;
  constructor(path: string) {
    super("VENUE_ERROR", `aster ${path}: status unknown (503)`);
    this.name = "AsterUnknownError";
    this.path = path;
  }
}

export function depthLimitFor(depth: number | undefined): DepthLimit {
  const d = depth ?? 20;
  for (const l of DEPTH_LIMITS) if (d <= l) return l;
  return 1000;
}

export function createAsterReader(cfg: AsterConfig, http: VenueHttp, cache: MarketDataCache | null, opts: AsterReaderOptions = {}): AsterReader {
  validateAsterConfig(cfg);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const tries = Math.max(1, opts.unknownTries ?? 3);
  const base = opts.backoffBaseMs ?? 250;
  let intervals: { at: number; map: Record<string, FundingInterval> } | null = null;
  let inflight: Promise<Record<string, FundingInterval>> | null = null;

  async function get<T>(path: string, q?: Record<string, string | number>): Promise<T> {
    assertV3Path(path);
    const cost = asterWeight(path, q ?? {});
    for (let i = 0; i < tries; i++) {
      if (i > 0) await sleep(base * 2 ** (i - 1));
      const r = await http.getJson<T>(path, q, cost);
      if (!isUnknownOutcome(r)) return r;
    }
    throw new AsterUnknownError(path);
  }

  async function fundingIntervals(): Promise<Record<string, FundingInterval>> {
    if (intervals && now() - intervals.at < FUNDING_INFO_MIN_GAP_MS) return intervals.map;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const rows = await get<AsterFundingInfoRow[]>("/fapi/v3/fundingInfo");
        intervals = { at: now(), map: fundingIntervalsFrom(rows) };
        return intervals.map;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** The cached table when it is under one hour old, else a fresh read. */
  async function freshIntervals(): Promise<Record<string, FundingInterval>> {
    if (intervals && now() - intervals.at < FUNDING_INFO_MAX_AGE_MS) return intervals.map;
    return fundingIntervals();
  }

  async function intervalFor(symbol: string): Promise<FundingInterval> {
    const map = await freshIntervals();
    const iv = map[symbol];
    if (!iv) throw new CapstanError("NOT_FOUND", `aster: no funding interval for ${symbol}`);
    return iv;
  }

  return {
    async listMarkets() {
      const info = await get<AsterExchangeInfo>("/fapi/v3/exchangeInfo");
      const map = await freshIntervals();
      const iso = new Date(now()).toISOString();
      const out: AsterMarket[] = [];
      for (const s of info.symbols) out.push(normalizeMarket(s, map[s.symbol], iso));
      if (cache) await cache.putMeta("aster", { serverTime: info.serverTime, symbols: out.length, at: iso });
      return out;
    },

    async getBook(id, depth) {
      const symbol = symbolOf(id);
      const limit = depthLimitFor(depth);
      const d = await get<AsterDepth>("/fapi/v3/depth", { symbol, limit });
      const book = normalizeBook(symbol, d, now());
      if (cache) await cache.putBook(book);
      return book;
    },

    async getFunding(id) {
      const symbol = symbolOf(id);
      const p = await get<AsterPremiumIndex>("/fapi/v3/premiumIndex", { symbol });
      const snap = normalizeFunding(p, await intervalFor(symbol));
      if (cache) await cache.putFunding(snap);
      return snap;
    },

    fundingIntervals,

    async allFunding() {
      const rows = await get<AsterPremiumIndex[]>("/fapi/v3/premiumIndex");
      const map = await freshIntervals();
      const out: FundingSnapshot[] = [];
      for (const p of rows) {
        const iv = map[p.symbol];
        if (iv) out.push(normalizeFunding(p, iv));
      }
      return out;
    },

    streamMarket(marketIds, onEvent, sopts = {}) {
      const symbols = marketIds.map(symbolOf);
      const wanted = new Set(symbols);
      const wsUrl = `${cfg.ws.replace(/\/+$/, "")}/ws`;
      const ws =
        opts.ws?.(wsUrl) ??
        venueWs(cfg.governorKey, wsUrl, {
          maxConns: 10,
          maxNewPerMin: 10,
          maxSubs: 1,
          pingMs: 0,
          pingMessage: null, // the server pings; the runtime answers pong frames
          unsubscribeMessage: (m) => ({ ...(m as object), method: "UNSUBSCRIBE" }),
        });
      // One subscription per connection (maxSubs 1): the client hands every message on a connection to every
      // subscriber on it, so sharing a connection would deliver each event twice.
      let id = 1;
      const deliver = (m: unknown) => {
        for (const e of wsEvents(m, intervals?.map ?? {}, wanted, sopts)) onEvent(e);
      };
      const streams = [MARK_ARR_STREAM, ...symbols.map(depthStream)];
      const unsubs: Unsubscribe[] = [];
      for (let i = 0; i < streams.length; i += WS_STREAMS_PER_CONN) {
        unsubs.push(ws.subscribe({ method: "SUBSCRIBE", params: streams.slice(i, i + WS_STREAMS_PER_CONN), id: id++ }, deliver));
      }
      return () => {
        for (const u of unsubs) u();
        if (!opts.ws) ws.close();
      };
    },

    intervalsAgeMs() {
      return intervals ? now() - intervals.at : null;
    },
  };
}

export type { Market };

/** The governed HTTP client for one Aster network (shared budget per egress IP through Redis when given). */
export function asterHttp(cfg: AsterConfig, gov: Governor, opts: VenueHttpOptions = {}): VenueHttp {
  validateAsterConfig(cfg);
  return venueHttp(cfg.governorKey, cfg.rest, gov, { userAgent: "capstan-aster", ...opts });
}

/** Egress label for the governor: the host's one static IP (never rotated), else "local". */
export function egressLabel(env: Record<string, string | undefined> = process.env): string {
  return env.RELAY_EGRESS_IP?.trim() || "local";
}

/** Reader wired from the environment: Redis governor when a client is given, else an in-process one. */
export function defaultAsterReader(opts: { redis?: Redis | null; cache?: MarketDataCache | null; network?: AsterNetwork; env?: Record<string, string | undefined> } = {}): AsterReader {
  const env = opts.env ?? process.env;
  const network: AsterNetwork = opts.network ?? (venueNetwork("aster", env) === "testnet" ? "Testnet" : "Mainnet");
  const cfg = asterConfig(network);
  const egress = egressLabel(env);
  const gov = opts.redis ? createGovernor(opts.redis, egress) : createMemoryGovernor(egress);
  return createAsterReader(cfg, asterHttp(cfg, gov), opts.cache ?? null);
}
