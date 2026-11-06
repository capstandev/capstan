// R13: the ingest reconnects after a drop, keeps the cache fresh, and stays inside the WS limits. Fake WS server.
import { afterAll, describe, expect, test } from "bun:test";
import { createTempDatabase, createDb, closeDb, memoryMarketDataCache, TEST_DATABASE_URL } from "@capstan/core";
import { db as tables } from "@capstan/schema";
import type { ServerWebSocket } from "bun";
import { createHlIngest, createHlReader, hlWs } from "../src";
import { CFG, fixtureHttp } from "./helpers";

function fakeHlWs() {
  const socks = new Set<ServerWebSocket<{ coins: Set<string> }>>();
  let accepted = 0;
  const server = Bun.serve<{ coins: Set<string> }, never>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      accepted++;
      if (srv.upgrade(req, { data: { coins: new Set<string>() } })) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        socks.add(ws);
      },
      message(ws, raw) {
        const m = JSON.parse(String(raw)) as { method: string; subscription?: { type: string; coin?: string } };
        if (m.method === "subscribe" && m.subscription?.type === "l2Book") ws.data.coins.add(m.subscription.coin!);
        if (m.method === "unsubscribe" && m.subscription?.coin) ws.data.coins.delete(m.subscription.coin);
      },
      close(ws) {
        socks.delete(ws);
      },
    },
  });
  const tick = setInterval(() => {
    for (const ws of socks)
      for (const coin of ws.data.coins) ws.send(JSON.stringify({ channel: "l2Book", data: { coin, time: Date.now(), levels: [[{ px: "100.0", sz: "1.0", n: 1 }], [{ px: "100.5", sz: "2.0", n: 1 }]] } }));
  }, 100);
  return {
    url: `ws://127.0.0.1:${server.port}`,
    dropAll() {
      for (const ws of socks) ws.close(1012, "restart");
    },
    open: () => socks.size,
    accepted: () => accepted,
    stop() {
      clearInterval(tick);
      server.stop(true);
    },
  };
}

const sleep = (ms: number) => Bun.sleep(ms);

describe("ingest", () => {
  test("reconnect-limits", async () => {
    const srv = fakeHlWs();
    const cfg = { ...CFG, wsUrl: srv.url };
    const ws = hlWs(cfg, { maxSubs: 2, backoffBaseMs: 30 });
    const cache = memoryMarketDataCache();
    const reader = createHlReader(cfg, fixtureHttp(), cache, { ws });
    const ingest = createHlIngest({ reader, cache, ws, dexes: [null], maxConns: 10, maxSubsPerConn: 2 });
    try {
      const st = await ingest.start();
      // 10 connections x 2 slots, one slot taken by allMids: 19 books; the rest are reported, not opened
      expect(st.subscribed).toBe(19);
      expect(st.skipped.length).toBeGreaterThan(0);
      await sleep(400);
      expect(ws.stats().connections).toBeLessThanOrEqual(10);
      expect(srv.open()).toBe(10);
      const fresh = async () => {
        let n = 0;
        for (const id of ingest.markets) {
          const b = await cache.getBook(id);
          if (!b) continue;
          expect(Date.now() - Date.parse(b.asOf)).toBeLessThanOrEqual(1000);
          n++;
        }
        return n;
      };
      expect(await fresh()).toBe(19);
      srv.dropAll();
      await sleep(150);
      // wait for the pool to come back
      for (let i = 0; i < 40 && srv.open() < 10; i++) await sleep(50);
      expect(srv.open()).toBe(10);
      await sleep(300);
      expect(await fresh()).toBe(19);
      const stats = ws.stats();
      expect(stats.connections).toBeLessThanOrEqual(10);
      // 10 first opens + 10 reconnects inside one minute: never more than 30
      expect(stats.opened).toBe(20);
      const lastMinute = stats.openedAt.filter((t) => t > Date.now() - 60_000).length;
      expect(lastMinute).toBeLessThanOrEqual(30);
      expect(srv.accepted()).toBe(20);
    } finally {
      ingest.stop();
      srv.stop();
    }
  }, 20_000);

  test("new-connection-rate-cap", async () => {
    const srv = fakeHlWs();
    const cfg = { ...CFG, wsUrl: srv.url };
    // a tiny pool so drops force reconnects quickly: at most 3 new connections per window
    const ws = hlWs(cfg, { maxConns: 2, maxSubs: 2, maxNewPerMin: 3, backoffBaseMs: 10, newConnWindowMs: 60_000 });
    const cache = memoryMarketDataCache();
    const reader = createHlReader(cfg, fixtureHttp(), cache, { ws });
    const ingest = createHlIngest({ reader, cache, ws, dexes: [null], maxConns: 2, maxSubsPerConn: 2 });
    try {
      await ingest.start();
      await sleep(200);
      srv.dropAll();
      await sleep(400);
      srv.dropAll();
      await sleep(400);
      expect(srv.accepted()).toBeLessThanOrEqual(3);
      expect(ws.stats().opened).toBeLessThanOrEqual(3);
    } finally {
      ingest.stop();
      srv.stop();
    }
  }, 20_000);

  const dbTest = TEST_DATABASE_URL ? test : test.skip;
  let drop: (() => Promise<void>) | null = null;
  afterAll(async () => {
    await drop?.();
  });
  dbTest("poll-writes-ticks", async () => {
    const tmp = await createTempDatabase(TEST_DATABASE_URL!, { migrated: true, prefix: "capstan_hl" });
    drop = tmp.drop;
    const db = createDb(tmp.url, { max: 2 });
    try {
      const cache = memoryMarketDataCache();
      const ws = hlWs({ ...CFG, wsUrl: "ws://127.0.0.1:9" }, { backoffBaseMs: 60_000 });
      const reader = createHlReader(CFG, fixtureHttp(), cache, { ws });
      const T = 1793934060000;
      const ingest = createHlIngest({ reader, cache, ws, db, dexes: [null, "xyz"], now: () => T });
      await ingest.start();
      await cache.putBook({ marketId: "hyperliquid:-:BTC", bids: Array.from({ length: 30 }, (_, i) => [`${100 - i}`, "1"] as [string, string]), asks: Array.from({ length: 30 }, (_, i) => [`${101 + i}`, "1"] as [string, string]), asOf: new Date().toISOString() });
      const r = await ingest.pollOnce();
      expect(r.errors).toEqual([]);
      expect(r.marks).toBe(179 + 120);
      expect(r.funding).toBe(r.marks);
      expect(r.snapshots).toBe(1);
      const marks = await db.select().from(tables.markTicks);
      const funding = await db.select().from(tables.fundingTicks);
      const snaps = await db.select().from(tables.bookSnapshots);
      expect(marks.length).toBe(r.marks);
      expect(funding.length).toBe(r.funding);
      expect(snaps.length).toBe(1);
      expect((snaps[0]!.bids as unknown[]).length).toBe(20);
      expect((snaps[0]!.asks as unknown[]).length).toBe(20);
      const btc = marks.find((m) => m.marketId === "hyperliquid:-:BTC")!;
      expect(Number(btc.mark)).toBe(76142.7);
      expect(funding.find((f) => f.marketId === "hyperliquid:xyz:TSLA")!.intervalS).toBe(3600);
      await ingest.pollOnce();
      expect((await db.select().from(tables.markTicks)).length).toBe(r.marks);
      ingest.stop();
    } finally {
      await closeDb(db);
    }
  }, 60_000);
});
