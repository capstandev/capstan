// The ingest stays bounded under a busy stream. Server defect: with 196 markets on one connection the pool handed every
// frame to all 198 subscribers and each turned it into events, so every frame became 198 cache writes (allMids: 198 x
// 196); with a slower Redis the pending writes grew about 70 MB/s and the first poll never ran. Deterministic counts.
import { describe, expect, test } from "bun:test";
import { memoryMarketDataCache, type MarketDataCache } from "@capstan/core";
import type { MarketEvent } from "@capstan/schema";
import type { VenueWs } from "@capstan/venue-client";
import { coalescingWriter, createHlIngest, createHlReader } from "../src";
import { CFG, fixtureHttp } from "./helpers";

/** The real pool's delivery: one connection, every frame (parsed once) goes to every subscriber on it. */
function fanOutWs() {
  const subs = new Map<number, { msg: any; onMsg: (m: unknown) => void }>();
  let next = 1;
  const ws: VenueWs = {
    subscribe(msg, onMsg) {
      const id = next++;
      subs.set(id, { msg, onMsg });
      return () => void subs.delete(id);
    },
    close: () => subs.clear(),
    stats: () => ({ connections: 1, opened: 1, subscriptions: subs.size, openedAt: [] }),
  };
  const emit = (frame: string) => {
    const m = JSON.parse(frame);
    for (const s of subs.values()) s.onMsg(m);
  };
  const coins = () => [...subs.values()].filter((s) => s.msg.subscription.type === "l2Book").map((s) => s.msg.subscription.coin as string);
  return { ws, emit, coins, size: () => subs.size };
}

const bookFrame = (coin: string, i: number) =>
  JSON.stringify({ channel: "l2Book", data: { coin, time: 1_700_000_000_000 + i, levels: [[{ px: "100.0", sz: "1.0", n: 1 }], [{ px: "100.5", sz: "2.0", n: 1 }]] } });
const midsFrame = (coins: string[]) => JSON.stringify({ channel: "allMids", data: { mids: Object.fromEntries(coins.map((c) => [c, "100.25"])) } });

/** A cache whose writes hang until released: a stalled Redis. Counts writes started and still pending. */
function stalledCache(): MarketDataCache & { started: number; pending: () => number; release: () => void } {
  const inner = memoryMarketDataCache();
  const waiting: (() => void)[] = [];
  let started = 0;
  const hold = <T>(f: () => Promise<T>) => {
    started++;
    return new Promise<void>((res) => waiting.push(() => void f().then(() => res())));
  };
  return {
    ...inner,
    putBook: (b) => hold(() => inner.putBook(b)),
    putMark: (id, mark, asOf) => hold(() => inner.putMark(id, mark, asOf)),
    get started() {
      return started;
    },
    pending: () => waiting.length,
    release() {
      for (const w of waiting.splice(0)) w();
    },
  };
}

describe("ingest memory", () => {
  test("one-event-per-frame", () => {
    const t = fanOutWs();
    const reader = createHlReader(CFG, fixtureHttp(), memoryMarketDataCache(), { ws: t.ws });
    const ids = Array.from({ length: 196 }, (_, i) => `hyperliquid:-:C${i}`);
    const events: MarketEvent[] = [];
    reader.streamMarket(ids, (e) => void events.push(e));
    expect(t.size()).toBe(197); // 196 books + 1 allMids
    const N = 5000;
    for (let i = 0; i < N; i++) t.emit(bookFrame(`C${i % 196}`, i));
    for (let i = 0; i < 50; i++) t.emit(midsFrame(t.coins()));
    expect(events.filter((e) => e.kind === "book").length).toBe(N);
    expect(events.filter((e) => e.kind === "mark").length).toBe(50 * 196);
  });

  test("stalled-cache-bounded-and-poll-runs", async () => {
    const t = fanOutWs();
    const cache = stalledCache();
    const reader = createHlReader(CFG, fixtureHttp(), cache, { ws: t.ws });
    const ingest = createHlIngest({ reader, cache, ws: t.ws, dexes: [null] });
    const st = await ingest.start();
    const markets = st.subscribed;
    expect(markets).toBeGreaterThan(10);
    const coins = t.coins();
    // 20,000 book frames and 200 mids frames while the cache never answers
    for (let i = 0; i < 20_000; i++) t.emit(bookFrame(coins[i % coins.length]!, i));
    for (let i = 0; i < 200; i++) t.emit(midsFrame(coins));
    // at most one book and one mark per market in flight, at most one of each waiting
    expect(cache.started).toBeLessThanOrEqual(2 * markets);
    expect(cache.pending()).toBeLessThanOrEqual(2 * markets);
    const p = ingest.pending();
    expect(p.queued).toBeLessThanOrEqual(2 * markets);
    expect(p.maxQueued).toBeLessThanOrEqual(2 * markets);
    expect(p.maxInFlight).toBeLessThanOrEqual(2 * markets);
    // the first poll runs while the stream is busy (reads do not queue behind the stream's writes)
    const r = await ingest.pollOnce();
    expect(r.errors).toEqual([]);
    expect(r.marks).toBeGreaterThan(0);
    // once the cache answers, the latest values land and the queue empties
    for (let i = 0; i < 5 && (cache.pending() > 0 || ingest.pending().queued > 0); i++) {
      cache.release();
      await Bun.sleep(0);
    }
    expect(ingest.pending().queued).toBe(0);
    expect(ingest.pending().inFlight).toBe(0);
    expect((await cache.getBook(`hyperliquid:-:${coins[0]}`))?.marketId).toBe(`hyperliquid:-:${coins[0]}`);
    ingest.stop();
  });

  test("writer-coalesces-per-market", async () => {
    const cache = stalledCache();
    const w = coalescingWriter(cache);
    const book = (id: string, i: number) => ({ marketId: id, bids: [], asks: [], asOf: new Date(i).toISOString() }) as any;
    for (let i = 0; i < 10_000; i++) w.book(book(`m${i % 7}`, i));
    // the first write is in flight; everything after it collapses to the latest book per market
    expect(cache.started).toBe(1);
    expect(w.stats().queued).toBe(7);
    cache.release();
    await Bun.sleep(0);
    cache.release();
    await w.idle();
    expect(w.stats().written).toBe(8);
    expect((await cache.getBook("m3"))?.asOf).toBe(new Date(9999).toISOString());
  });

  test("failed-writes-log-once-per-batch", async () => {
    const lines: unknown[] = [];
    const down: MarketDataCache = { ...memoryMarketDataCache(), putBook: async () => Promise.reject(new Error("MISCONF")), putMark: async () => Promise.reject(new Error("MISCONF")) };
    const w = coalescingWriter(down, { error: (_m: string, f?: unknown) => void lines.push(f) });
    for (let i = 0; i < 1000; i++) w.book({ marketId: `m${i % 50}`, bids: [], asks: [], asOf: "" } as any);
    await w.idle();
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]).toMatchObject({ error: "Error: MISCONF" });
  });
});
