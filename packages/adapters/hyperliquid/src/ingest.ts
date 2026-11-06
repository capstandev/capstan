// Hyperliquid market-data ingest (spec 9 `ingest-hl`). One process holds one pool of at most 10 WebSocket connections
// (30 new per minute, 1,000 subscriptions each, venue limits per IP); subscriptions are added dex by dex, so each
// connection carries one dex's books where it can. Books and mids go to the MarketDataCache (1 s TTL), which also
// publishes PUBSUB.book / PUBSUB.mark. Every 60 s it polls metaAndAssetCtxs per dex for marks and funding into
// mark_ticks / funding_ticks and stores the top 20 levels of every cached book into book_snapshots.
// It never subscribes to user channels (the venue allows only 10 unique users per IP).
import { memoryMarketDataCache, type Db, type Logger, type MarketDataCache, type Redis } from "@capstan/core";
import { db as tables, venueNetwork, type OrderBook } from "@capstan/schema";
import { createGovernor, createMemoryGovernor, venueHttp, type Governor, type VenueHttp, type VenueWs } from "@capstan/venue-client";
import { parseMarketId } from "./meta";
import { mulStr, type HlMarket } from "./normalize";
import { createHlReader, HL_MAINNET, HL_TESTNET, hlWs, type HlConfig, type HlReader } from "./read";

export interface HlIngestOptions {
  reader: HlReader;
  cache: MarketDataCache;
  ws: VenueWs;
  db?: Db | null;
  log?: Pick<Logger, "info" | "warn" | "error">;
  now?: () => number;
  /** Dexes to stream (null = core). Default: core, xyz, io, para (the executable candidates). */
  dexes?: (string | null)[];
  maxConns?: number; // 10
  maxSubsPerConn?: number; // 1000
  snapshotTopN?: number; // 20
}

export interface HlPollReport {
  marks: number;
  funding: number;
  snapshots: number;
  dexes: number;
  errors: string[];
}

export interface HlIngest {
  /** Load the markets and subscribe. Idempotent. skippedDexes: configured dexes this network does not list. */
  start(): Promise<{ subscribed: number; skipped: string[]; skippedDexes: string[] }>;
  pollOnce(): Promise<HlPollReport>;
  stop(): void;
  readonly markets: string[];
}

export const DEFAULT_INGEST_DEXES: (string | null)[] = [null, "xyz", "io", "para"];

export function createHlIngest(o: HlIngestOptions): HlIngest {
  const now = o.now ?? Date.now;
  const maxConns = o.maxConns ?? 10;
  const maxSubs = o.maxSubsPerConn ?? 1000;
  const topN = o.snapshotTopN ?? 20;
  const wanted = o.dexes ?? DEFAULT_INGEST_DEXES;
  let started: { subscribed: number; skipped: string[]; skippedDexes: string[] } | null = null;
  // the dexes polled: the configured ones this network lists (testnet has no io or para)
  let polled: (string | null)[] = wanted;
  let unsub: (() => void) | null = null;
  const marketIds: string[] = [];

  async function start() {
    if (started) return started;
    const all = await o.reader.listMarkets();
    const listed = new Set<string | null>([null, ...all.map((m) => m.dex)]);
    const skippedDexes = wanted.filter((d): d is string => d !== null && !listed.has(d));
    polled = wanted.filter((d) => listed.has(d));
    if (skippedDexes.length) o.log?.warn("ingest-hl: configured dexes not listed on this network, skipped", { dexes: skippedDexes });
    const active = all.filter((m) => m.status !== "delisted" && wanted.includes(m.dex));
    // dex by dex, in the configured order, so each connection carries one dex where it can
    active.sort((a, b) => wanted.indexOf(a.dex) - wanted.indexOf(b.dex) || (a.venueIndex ?? 0) - (b.venueIndex ?? 0));
    const dexCount = new Set(active.map((m) => m.dex)).size;
    // one allMids subscription per dex also takes a slot
    const capacity = maxConns * maxSubs - dexCount;
    const take = active.slice(0, Math.max(0, capacity));
    const skipped = active.slice(take.length).map((m) => m.id);
    if (skipped.length) o.log?.warn("ingest-hl: subscription capacity reached", { skipped: skipped.length });
    marketIds.push(...take.map((m: HlMarket) => m.id));
    unsub = o.reader.streamMarket(marketIds, (e) => {
      const p = e.kind === "book" ? o.cache.putBook(e.book) : e.kind === "mark" ? o.cache.putMark(e.marketId, e.mark, e.asOf) : null;
      p?.catch((err) => o.log?.error("ingest-hl: cache write failed", { error: String(err) }));
    });
    started = { subscribed: take.length, skipped, skippedDexes };
    o.log?.info("ingest-hl: streaming", { markets: take.length, dexes: dexCount });
    return started;
  }

  async function pollOnce(): Promise<HlPollReport> {
    const report: HlPollReport = { marks: 0, funding: 0, snapshots: 0, dexes: 0, errors: [] };
    const ts = new Date(now());
    const markRows: (typeof tables.markTicks.$inferInsert)[] = [];
    const fundRows: (typeof tables.fundingTicks.$inferInsert)[] = [];
    for (const dex of polled) {
      try {
        const [meta, ctxs] = await o.reader.metaAndAssetCtxs(dex);
        report.dexes++;
        meta.universe.forEach((u, i) => {
          const c = ctxs[i];
          if (!c || u.isDelisted) return;
          const id = `hyperliquid:${dex ?? "-"}:${dex ? u.name.slice(dex.length + 1) : u.name}`;
          markRows.push({ ts, marketId: id, mark: c.markPx, index: c.oraclePx ?? null, oiUsd: mulStr(c.openInterest, c.markPx) });
          fundRows.push({ ts, marketId: id, ratePerInterval: c.funding, intervalS: 3600, ratePerHour: c.funding, predictedNext: null, source: "venue" });
        });
      } catch (e) {
        report.errors.push(`metaAndAssetCtxs dex ${dex ?? "core"}: ${(e as Error).message}`);
      }
    }
    const snapRows: (typeof tables.bookSnapshots.$inferInsert)[] = [];
    for (const id of marketIds) {
      const b: OrderBook | null = await o.cache.getBook(id);
      if (!b) continue;
      parseMarketId(id);
      snapRows.push({ ts, marketId: id, bids: b.bids.slice(0, topN), asks: b.asks.slice(0, topN) });
    }
    report.marks = markRows.length;
    report.funding = fundRows.length;
    report.snapshots = snapRows.length;
    if (o.db) {
      const chunk = <T>(xs: T[], n = 500) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
      for (const c of chunk(markRows)) await o.db.insert(tables.markTicks).values(c).onConflictDoNothing();
      for (const c of chunk(fundRows)) await o.db.insert(tables.fundingTicks).values(c).onConflictDoNothing();
      for (const c of chunk(snapRows)) await o.db.insert(tables.bookSnapshots).values(c).onConflictDoNothing();
    }
    return report;
  }

  return {
    start,
    pollOnce,
    stop() {
      unsub?.();
      unsub = null;
      o.ws.close();
    },
    get markets() {
      return [...marketIds];
    },
  };
}

// ---------------- runtime wiring for the worker job and the catalog source ----------------

export interface HlRuntime {
  cfg: HlConfig;
  governor: Governor;
  http: VenueHttp;
  reader: HlReader;
}

/**
 * Build the governed HTTP client and reader from the environment. The network profile decides (venueNetwork): local
 * and testnet read the testnet host, mainnet the mainnet host; HL_NETWORK overrides it.
 * The governor shares budgets through Redis when one is given, else it is per process.
 */
export function createHlRuntime(env: Record<string, string | undefined>, deps: { redis?: Redis | null; cache?: MarketDataCache | null } = {}): HlRuntime {
  const testnet = venueNetwork("hyperliquid", env) === "testnet";
  const base = testnet ? HL_TESTNET : HL_MAINNET;
  const builder = env.HL_BUILDER_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(env.HL_BUILDER_ADDRESS) ? (env.HL_BUILDER_ADDRESS.toLowerCase() as `0x${string}`) : null;
  const cfg: HlConfig = { ...base, builderAddress: builder };
  const egress = env.EGRESS_ID ?? env.RELAY_EGRESS_ID ?? "local";
  const governor = deps.redis ? createGovernor(deps.redis, egress) : createMemoryGovernor(egress);
  const venue = testnet ? "hyperliquid-testnet" : "hyperliquid";
  const http = venueHttp(venue, cfg.infoUrl.replace(/\/info$/, ""), governor, { priority: "free" });
  const reader = createHlReader(cfg, http, deps.cache ?? memoryMarketDataCache());
  return { cfg, governor, http, reader };
}

/** Process-wide ingest for the worker job: started on the first run, polled on every run. */
let shared: { ingest: HlIngest; rt: HlRuntime } | null = null;

export async function sharedHlIngest(env: Record<string, string | undefined>, deps: { redis: Redis | null; cache: MarketDataCache | null; db: Db | null; log: Pick<Logger, "info" | "warn" | "error"> }): Promise<HlIngest> {
  if (shared) return shared.ingest;
  const cache = deps.cache ?? memoryMarketDataCache();
  const rt = createHlRuntime(env, { redis: deps.redis, cache });
  const dexes = (env.HL_INGEST_DEXES ?? "core,xyz,io,para")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === "core" ? null : s));
  const ws = hlWs(rt.cfg, { onError: (e) => deps.log.warn("ingest-hl: ws error", { error: String((e as Error)?.message ?? e) }) });
  const ingest = createHlIngest({ reader: createHlReader(rt.cfg, rt.http, cache, { ws }), cache, ws, db: deps.db, log: deps.log, dexes });
  shared = { ingest, rt };
  await ingest.start();
  return ingest;
}

/** For tests: forget the shared ingest after stopping it. */
export function resetSharedHlIngest(): void {
  shared?.ingest.stop();
  shared = null;
}

