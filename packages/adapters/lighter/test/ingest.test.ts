// R9: at most 1 REST request per second per config (governor), WS reconnect with backoff and resubscribe, never more
// than 500 subscriptions per connection; plus the book state machine (snapshot, deltas, nonce gap) and stats events.
import { afterAll, describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import type { MarketEvent } from "@capstan/schema";
import { createMemoryGovernor, venueWs } from "@capstan/venue-client";
import { createLighterIngest, LIGHTER_CONFIGS, LIGHTER_WS_MAX_SUBS, lighterReaderFor, lighterWsOptions, LocalBook } from "../src";
import { fakeClock, fakeLighter, FIXTURES } from "./helpers";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type WsRec = { messages: Record<string, unknown>[] };
const wsFx = (v: string) => JSON.parse(readFileSync(join(FIXTURES, v, "ws_market0.json"), "utf8")) as WsRec;

const waitFor = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timeout");
    await Bun.sleep(5);
  }
};

/** A local Lighter-like stream: answers order_book/0 with the recorded snapshot and deltas, market_stats/all with stats. */
function lighterWsServer(rec: WsRec) {
  const books = rec.messages.filter((m) => String(m.type).endsWith("order_book"));
  const stats = rec.messages.filter((m) => String(m.type).endsWith("market_stats"));
  const conns: { msgs: Record<string, unknown>[] }[] = [];
  const sockets = new Set<Bun.ServerWebSocket<{ msgs: Record<string, unknown>[] }>>();
  const server = Bun.serve<{ msgs: Record<string, unknown>[] }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const c = { msgs: [] as Record<string, unknown>[] };
      conns.push(c);
      return srv.upgrade(req, { data: c }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "connected" }));
      },
      message(ws, raw) {
        const m = JSON.parse(String(raw)) as Record<string, unknown>;
        ws.data.msgs.push(m);
        if (m.type === "subscribe" && m.channel === "order_book/0") for (const b of books) ws.send(JSON.stringify(b));
        if (m.type === "subscribe" && m.channel === "market_stats/all")
          for (const s of stats) {
            const one = s.market_stats as { market_id: number };
            ws.send(JSON.stringify({ ...s, channel: "market_stats:all", market_stats: { [one.market_id]: one } }));
          }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    conns,
    send: (m: unknown) => [...sockets].forEach((s) => s.send(JSON.stringify(m))),
    closeAll: () => [...sockets].forEach((s) => s.close()),
    stop: () => server.stop(true),
  };
}

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

describe("ingest", () => {
  test("limits", async () => {
    // 1) REST: at most one request per second per config, configs independent
    const main = fakeLighter("lighter-304");
    const rh = fakeLighter("lighter-466324");
    cleanup.push(main.stop, rh.stop);
    const clock = fakeClock();
    const base = createMemoryGovernor("t", clock.opts);
    const times: Record<string, number[]> = { "lighter-304": [], "lighter-466324": [] };
    // the lease time is the governor clock at grant
    const gov = { ...base, acquire: async (...a: Parameters<typeof base.acquire>) => {
      const l = await base.acquire(...a);
      times[String(l.venue)]?.push(l.at);
      return l;
    } };
    const rm = lighterReaderFor(LIGHTER_CONFIGS.mainnet, gov, null, { rest: main.url, now: clock.now });
    const rr = lighterReaderFor(LIGHTER_CONFIGS.rh, gov, null, { rest: rh.url, now: clock.now });
    await Promise.all([...Array.from({ length: 6 }, () => rm.nextNonce(3, 4)), ...Array.from({ length: 6 }, () => rr.nextNonce(3, 4)), rm.health(), rr.health()]);
    expect(main.hits.length).toBe(7);
    expect(rh.hits.length).toBe(7);
    for (const k of Object.keys(times)) {
      const t = times[k]!.slice().sort((a, b) => a - b);
      expect(t.length).toBe(7);
      for (let i = 1; i < t.length; i++) expect(t[i]! - t[i - 1]!).toBeGreaterThanOrEqual(1000);
    }
    // both configs started together: separate buckets
    expect(Math.abs(Math.min(...times["lighter-304"]!) - Math.min(...times["lighter-466324"]!))).toBeLessThan(1000);

    // 2) WS: snapshot + deltas build a book, stats feed marks and funding, a close reconnects and resubscribes
    const srv = lighterWsServer(wsFx("lighter-304"));
    cleanup.push(srv.stop);
    const ws = venueWs("lighter-304", srv.url, { ...lighterWsOptions(), backoffBaseMs: 20, backoffMaxMs: 100 });
    const ingest = createLighterIngest(LIGHTER_CONFIGS.mainnet, { ws });
    cleanup.push(() => ingest.close());
    const events: MarketEvent[] = [];
    const cache = memoryMarketDataCache();
    ingest.start([{ id: "lighter-mainnet:-:ETH", index: 0, capPerHour: "0.005" }], (e) => {
      events.push(e);
      if (e.kind === "book") void cache.putBook(e.book);
    });
    await waitFor(() => events.filter((e) => e.kind === "book").length >= 6 && events.some((e) => e.kind === "funding"));
    const lastBook = events.filter((e) => e.kind === "book").pop() as Extract<MarketEvent, { kind: "book" }>;
    expect(lastBook.book.bids.length).toBeGreaterThan(0);
    expect(Number(lastBook.book.bids[0]![0])).toBeLessThan(Number(lastBook.book.asks[0]![0])); // not crossed
    expect(lastBook.book.asks.every(([, sz]) => Number(sz) > 0)).toBe(true); // size 0 removed levels
    const fund = events.find((e) => e.kind === "funding") as Extract<MarketEvent, { kind: "funding" }>;
    expect(fund.funding).toMatchObject({ marketId: "lighter-mainnet:-:ETH", intervalS: 3600, ratePerInterval: "0.0012", ratePerHour: "0.000012", capPerHour: "0.005", source: "venue" });
    expect(events.some((e) => e.kind === "mark" && e.marketId === "lighter-mainnet:-:ETH")).toBe(true);
    expect(srv.conns.length).toBe(1);
    srv.closeAll();
    await waitFor(() => srv.conns.length === 2 && srv.conns[1]!.msgs.filter((m) => m.type === "subscribe").length === 2);
    const resubs = srv.conns[1]!.msgs.filter((m) => m.type === "subscribe").map((m) => m.channel);
    expect(resubs.sort()).toEqual(["market_stats/all", "order_book/0"]); // each once
    // a delta whose begin_nonce does not follow the last nonce drops the book and resubscribes for a fresh snapshot
    const before = ingest.stats().gaps;
    srv.send({ channel: "order_book:0", type: "update/order_book", order_book: { asks: [], bids: [], begin_nonce: 1, nonce: 2 } });
    await waitFor(() => ingest.stats().gaps === before + 1);
    await waitFor(() => srv.conns[1]!.msgs.filter((m) => m.type === "unsubscribe" && m.channel === "order_book/0").length === 1);

    // 3) never more than 500 subscriptions per connection, whatever the market count
    expect(lighterWsOptions().maxSubs).toBe(LIGHTER_WS_MAX_SUBS);
    expect(LIGHTER_WS_MAX_SUBS).toBe(500);
    const big = lighterWsServer({ messages: [] });
    cleanup.push(big.stop);
    const ws2 = venueWs("lighter-304", big.url, { ...lighterWsOptions(), maxConns: 1 });
    const ing2 = createLighterIngest(LIGHTER_CONFIGS.mainnet, { ws: ws2, maxBooks: 10_000 });
    cleanup.push(() => ing2.close());
    ing2.start(Array.from({ length: 800 }, (_, i) => ({ id: `lighter-mainnet:-:M${i}`, index: i })), () => undefined);
    await waitFor(() => big.conns.length === 1 && big.conns[0]!.msgs.length >= 500);
    await Bun.sleep(50);
    expect(ing2.stats().subscriptions).toBeLessThanOrEqual(500);
    expect(big.conns.length).toBe(1);
    expect(big.conns[0]!.msgs.filter((m) => m.type === "subscribe").length).toBe(500);
  });

  test("local book: snapshot, deltas, removal and gap", () => {
    const b = new LocalBook();
    expect(b.apply({ type: "update/order_book", order_book: { asks: [{ price: "2", size: "1" }], nonce: 5 } })).toBe(true);
    expect(b.ready).toBe(false); // deltas before the snapshot are ignored
    b.apply({ type: "subscribed/order_book", order_book: { asks: [{ price: "2", size: "1" }, { price: "3", size: "1" }], bids: [{ price: "1", size: "4" }], nonce: 10 } });
    b.apply({ type: "update/order_book", order_book: { asks: [{ price: "2", size: "0.0000" }], bids: [{ price: "1.5", size: "2" }], begin_nonce: 10, nonce: 11 } });
    const top = b.top("m", 20, 0);
    expect(top.asks).toEqual([["3", "1"]]);
    expect(top.bids).toEqual([["1.5", "2"], ["1", "4"]]);
    expect(top.seq).toBe(11);
    expect(b.apply({ type: "update/order_book", order_book: { begin_nonce: 99, nonce: 100 } })).toBe(false);
    expect(b.ready).toBe(false);
  });
});
