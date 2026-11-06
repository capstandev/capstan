// Lighter ingest (both mainnet configs). WebSocket first: one stream per config carries books (order_book/{i}) and
// every market's mark and funding (market_stats/all) into the market-data cache, which also publishes to the gateway.
// Timescale gets at most one mark tick, one funding tick and one top-20 book snapshot per market per minute.
// This job runs every 5 minutes: the first run opens the streams; every run re-reads orderBookDetails over REST (two
// calls per config through the 1 req/s governor) and resubscribes only when the set of live perps changed.
import { createLighterIngest, lighterReaderFor, LIGHTER_CONFIGS, type IngestMarket, type LighterConfig, type LighterIngest, type LighterReader } from "@capstan/adapter-lighter";
import type { Db, JobDef, JobDeps, MarketDataCache } from "@capstan/core";
import { db as schema, type MarketEvent, type Unsubscribe } from "@capstan/schema";
import { createGovernor, createMemoryGovernor, type Governor } from "@capstan/venue-client";

export const INGEST_LIGHTER_EVERY_MS = 5 * 60_000;
export const PERSIST_EVERY_MS = 60_000;

export interface ConfigRun {
  cfg: Readonly<LighterConfig>;
  reader: LighterReader;
  ingest: LighterIngest;
  markets: IngestMarket[];
  unsub: Unsubscribe | null;
  lastPersist: Map<string, number>;
}

export interface IngestState {
  runs: ConfigRun[];
}

let state: IngestState | null = null;

export interface IngestFactories {
  reader?: (cfg: Readonly<LighterConfig>, gov: Governor, cache: MarketDataCache | null) => LighterReader;
  ingest?: (cfg: Readonly<LighterConfig>) => LighterIngest;
  configs?: Readonly<LighterConfig>[];
}

/** Persist one event, throttled per market and kind. Errors are logged, never thrown into the stream. */
export async function persistEvent(db: Db | null, run: Pick<ConfigRun, "lastPersist">, e: MarketEvent, nowMs: number): Promise<boolean> {
  if (!db) return false;
  const id = e.kind === "book" ? e.book.marketId : e.kind === "funding" ? e.funding.marketId : e.kind === "mark" ? e.marketId : null;
  if (!id) return false;
  const key = `${e.kind}:${id}`;
  const last = run.lastPersist.get(key) ?? 0;
  if (nowMs - last < PERSIST_EVERY_MS) return false;
  run.lastPersist.set(key, nowMs);
  const ts = new Date(Math.floor(nowMs / 1000) * 1000);
  if (e.kind === "mark") await db.insert(schema.markTicks).values({ ts, marketId: id, mark: e.mark, index: e.index ?? null }).onConflictDoNothing();
  else if (e.kind === "funding")
    await db
      .insert(schema.fundingTicks)
      .values({ ts, marketId: id, ratePerInterval: e.funding.ratePerInterval, intervalS: e.funding.intervalS, ratePerHour: e.funding.ratePerHour, predictedNext: e.funding.predictedNext, source: e.funding.source })
      .onConflictDoNothing();
  else if (e.kind === "book") await db.insert(schema.bookSnapshots).values({ ts, marketId: id, bids: e.book.bids.slice(0, 20), asks: e.book.asks.slice(0, 20) }).onConflictDoNothing();
  return true;
}

function liveMarkets(ms: Awaited<ReturnType<LighterReader["listMarkets"]>>, metas: Map<string, { capPerHour: string | null }>): IngestMarket[] {
  return ms
    .filter((m) => m.marketType === "perp" && m.status !== "delisted")
    .map((m) => ({ id: m.id, index: m.venueIndex as number, capPerHour: metas.get(m.id)?.capPerHour ?? null }))
    .sort((a, b) => a.index - b.index);
}

const sameSet = (a: IngestMarket[], b: IngestMarket[]) => a.length === b.length && a.every((m, i) => m.id === b[i]!.id && m.index === b[i]!.index);

/** One tick: open the streams on the first call, refresh market metadata on every call. */
export async function runIngestTick(deps: JobDeps, f: IngestFactories = {}, st: IngestState | null = state): Promise<{ configs: { venue: string; markets: number; books: number; subscriptions: number; gaps: number }[]; state: IngestState }> {
  const egress = process.env.CAPSTAN_EGRESS_ID ?? "local";
  if (!st) {
    const gov = deps.redis ? createGovernor(deps.redis, egress) : createMemoryGovernor(egress);
    const configs = f.configs ?? [LIGHTER_CONFIGS.mainnet, LIGHTER_CONFIGS.rh];
    st = {
      runs: configs.map((cfg) => ({
        cfg,
        reader: (f.reader ?? lighterReaderFor)(cfg, gov, deps.cache),
        ingest: (f.ingest ?? ((c) => createLighterIngest(c, { onError: (e) => deps.log.warn("lighter ws error", { venue: c.venue, error: String(e) }) })))(cfg),
        markets: [],
        unsub: null,
        lastPersist: new Map(),
      })),
    };
    if (!f.reader && !f.ingest && !f.configs) state = st; // the production singleton; tests keep their own state
  }
  const out: { venue: string; markets: number; books: number; subscriptions: number; gaps: number }[] = [];
  for (const run of st.runs) {
    try {
      const listed = await run.reader.listMarkets();
      const metas = new Map<string, { capPerHour: string | null }>();
      for (const m of listed) if (m.marketType === "perp") metas.set(m.id, await run.reader.marketMeta(m.id));
      const next = liveMarkets(listed, metas);
      if (!run.unsub || !sameSet(next, run.markets)) {
        run.unsub?.();
        run.markets = next;
        run.unsub = run.ingest.start(next, (e) => {
          void handleEvent(deps, run, e);
        });
      }
    } catch (e) {
      deps.log.warn("ingest-lighter refresh failed", { venue: run.cfg.venue, error: (e as Error).message });
    }
    const s = run.ingest.stats();
    out.push({ venue: run.cfg.venue, markets: run.markets.length, books: s.books, subscriptions: s.subscriptions, gaps: s.gaps });
  }
  deps.log.info("ingest-lighter tick", { configs: out });
  return { configs: out, state: st };
}

async function handleEvent(deps: JobDeps, run: ConfigRun, e: MarketEvent): Promise<void> {
  try {
    if (deps.cache) {
      if (e.kind === "book") await deps.cache.putBook(e.book);
      else if (e.kind === "mark") await deps.cache.putMark(e.marketId, e.mark, e.asOf);
      else if (e.kind === "funding") await deps.cache.putFunding(e.funding);
    }
    await persistEvent(deps.db, run, e, deps.now().getTime());
  } catch (err) {
    deps.log.warn("ingest-lighter write failed", { venue: run.cfg.venue, error: (err as Error).message });
  }
}

/** Stop every stream this process opened (tests and shutdown). */
export function stopIngest(st: IngestState | null = state): void {
  for (const r of st?.runs ?? []) {
    r.unsub?.();
    r.ingest.close();
  }
  if (st === state) state = null;
}

export const job: JobDef = {
  name: "ingest-lighter",
  queue: "fundingTick",
  schedule: { every: INGEST_LIGHTER_EVERY_MS },
  concurrency: 1,
  handler: (_job, deps) => runIngestTick(deps),
};
