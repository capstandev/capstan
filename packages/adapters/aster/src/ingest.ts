// Aster ingest loop. One long-lived stream per process (WS `!markPrice@arr` for marks and funding every second, depth
// streams only for routed symbols) plus a 60 s tick that re-reads the funding-interval table (fundingInfo, weight 10,
// at most once per minute) so an interval change shows up within one tick. If the mark stream went quiet, the tick
// falls back to one no-symbol premiumIndex read (weight 10) so funding never goes stale silently.
import type { MarketDataCache } from "@capstan/core";
import type { FundingSnapshot, MarketEvent, Unsubscribe } from "@capstan/schema";
import { asterMarketId } from "./normalize";
import type { AsterReader } from "./read";

/** Mark stream silence after which the tick reads funding over REST. */
export const MARK_STALE_MS = 10_000;

export interface AsterIngestDeps {
  reader: AsterReader;
  cache: MarketDataCache;
  /** Venue symbols to stream depth for (executable markets). */
  routedSymbols: () => Promise<string[]>;
  now?: () => number;
  /** Optional sink for history rows (funding_ticks); the feeds work owns persistence. */
  onFunding?: (f: FundingSnapshot) => void | Promise<void>;
}

export interface TickReport {
  intervals: number;
  intervalChanges: { symbol: string; fromS: number; toS: number }[];
  restFunding: number;
  routed: number;
  resubscribed: boolean;
}

export interface AsterIngest {
  tick(): Promise<TickReport>;
  handle(e: MarketEvent): Promise<void>;
  stop(): void;
  lastMarkAt(): number | null;
}

export function createAsterIngest(deps: AsterIngestDeps): AsterIngest {
  const now = deps.now ?? Date.now;
  let unsub: Unsubscribe | null = null;
  let routedKey = "";
  let lastMark: number | null = null;
  let lastIntervals: Record<string, number> = {};
  const pending = new Set<Promise<void>>();

  async function handle(e: MarketEvent): Promise<void> {
    if (e.kind === "mark") {
      lastMark = now();
      await deps.cache.putMark(e.marketId, e.mark, e.asOf);
    } else if (e.kind === "funding") {
      await deps.cache.putFunding(e.funding);
      await deps.onFunding?.(e.funding);
    } else if (e.kind === "book") {
      await deps.cache.putBook(e.book);
    }
  }

  function onEvent(e: MarketEvent): void {
    const p = handle(e).catch(() => undefined);
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }

  return {
    async tick() {
      const map = await deps.reader.fundingIntervals();
      const changes: TickReport["intervalChanges"] = [];
      const next: Record<string, number> = {};
      for (const [sym, iv] of Object.entries(map)) {
        next[sym] = iv.hours * 3600;
        const prev = lastIntervals[sym];
        if (prev !== undefined && prev !== next[sym]) changes.push({ symbol: sym, fromS: prev, toS: next[sym]! });
      }
      lastIntervals = next;
      // A changed interval invalidates any cached snapshot computed with the old one: refresh those now.
      let restFunding = 0;
      const stale = lastMark === null || now() - lastMark > MARK_STALE_MS;
      if (stale || changes.length) {
        const snaps = await deps.reader.allFunding();
        const changed = new Set(changes.map((c) => asterMarketId(c.symbol)));
        for (const s of snaps) {
          if (!stale && !changed.has(s.marketId)) continue;
          await deps.cache.putFunding(s);
          await deps.onFunding?.(s);
          restFunding++;
        }
      }
      const routed = [...new Set(await deps.routedSymbols())].sort();
      const key = routed.join(",");
      let resubscribed = false;
      if (!unsub || key !== routedKey) {
        unsub?.();
        unsub = deps.reader.streamMarket(routed.map(asterMarketId), onEvent, { allMarks: true });
        routedKey = key;
        resubscribed = true;
      }
      await Promise.all([...pending]);
      return { intervals: Object.keys(map).length, intervalChanges: changes, restFunding, routed: routed.length, resubscribed };
    },
    handle,
    stop() {
      unsub?.();
      unsub = null;
      routedKey = "";
    },
    lastMarkAt: () => lastMark,
  };
}
