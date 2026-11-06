// Ingest loop and the drop-in worker files (todo 13): WS events land in the cache, depth streams only for routed
// symbols, a quiet mark stream falls back to one REST read, and the job and catalog source load by glob.
import { closeDb, createDb, createTempDatabase, memoryMarketDataCache } from "@capstan/core";
import { syncMarkets } from "@capstan/catalog";
import { db as schema } from "@capstan/schema";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createAsterIngest, MARK_STALE_MS } from "../src/ingest";
import { wsEvents, fundingIntervalsFrom } from "../src/normalize";
import { fixture, fundingInfo, harness } from "./helpers";
import { fakeWs } from "./ws-helpers";

const WORKERS = join(import.meta.dir, "../../../../apps/workers/src");
const BASE = process.env.DATABASE_URL;
const dbTest = BASE ? test : test.skip;

describe("aster ingest", () => {
  test("ws-events-recorded", () => {
    const msgs = fixture<unknown[]>("ws.stream");
    const intervals = fundingIntervalsFrom(fundingInfo());
    const events = msgs.flatMap((m) => wsEvents(m, intervals));
    const books = events.filter((e) => e.kind === "book");
    const marks = events.filter((e) => e.kind === "mark");
    const funding = events.filter((e) => e.kind === "funding");
    expect(books.length).toBe(1);
    expect(books[0]!.kind === "book" && books[0]!.book.marketId).toBe("aster:-:BTCUSDT");
    expect(books[0]!.kind === "book" && books[0]!.book.bids.length).toBe(20);
    expect(marks.length).toBe(5);
    expect(funding.length).toBe(5);
    const btc = funding.find((e) => e.kind === "funding" && e.funding.marketId === "aster:-:BTCUSDT");
    expect(btc && btc.kind === "funding" && btc.funding.intervalS).toBe(intervals.BTCUSDT!.hours * 3600);
    // wrapped /stream form and filtering by wanted symbols
    const wrapped = wsEvents({ stream: "!markPrice@arr", data: msgs[2] }, intervals, new Set(["ETHUSDT"]));
    expect(wrapped.map((e) => e.kind)).toEqual(["mark", "funding"]);
    // a symbol with no known interval gives a mark only, and junk is ignored
    expect(wsEvents(msgs[2], {}).every((e) => e.kind === "mark")).toBe(true);
    expect(wsEvents({ id: 1, result: null }, intervals)).toEqual([]);
    expect(wsEvents(null, intervals)).toEqual([]);
  });

  test("tick-streams-routed-only", async () => {
    let clock = 1_793_933_000_000;
    const fw = fakeWs();
    const h = harness(undefined, { now: () => clock, ws: () => fw.ws });
    const cache = memoryMarketDataCache();
    let routed = ["BTCUSDT"];
    const ingest = createAsterIngest({ reader: h.reader, cache, routedSymbols: async () => routed, now: () => clock });
    try {
      const r1 = await ingest.tick();
      expect(r1.resubscribed).toBe(true);
      expect(r1.restFunding).toBeGreaterThan(590); // no mark yet: REST fallback filled the cache
      expect(fw.active()).toEqual([{ method: "SUBSCRIBE", params: ["!markPrice@arr", "btcusdt@depth20@100ms"], id: 1 }]);
      // stream events land in the cache
      const msgs = fixture<unknown[]>("ws.stream");
      for (const m of msgs) fw.push(m);
      await Bun.sleep(5);
      expect((await cache.getBook("aster:-:BTCUSDT"))!.bids.length).toBe(20);
      expect((await cache.getMark("aster:-:ETHUSDT"))!.mark).toBe("2245.66572480");
      // marks are fresh: the next tick makes no REST funding read and keeps the subscription
      clock += 60_000;
      const piHits = () => h.server.hits.filter((x) => x === "GET /fapi/v3/premiumIndex").length;
      const before = piHits();
      const lastMark = ingest.lastMarkAt()!;
      clock = lastMark + 1000;
      const r2 = await ingest.tick();
      expect(r2.restFunding).toBe(0);
      expect(r2.resubscribed).toBe(false);
      expect(piHits()).toBe(before);
      // the routed set changes: one resubscribe with the new depth streams
      routed = ["ETHUSDT", "BTCUSDT", "ETHUSDT"];
      clock += MARK_STALE_MS + 1;
      const r3 = await ingest.tick();
      expect(r3.resubscribed).toBe(true);
      expect(r3.restFunding).toBeGreaterThan(0); // stream went quiet
      expect(fw.active()).toEqual([{ method: "SUBSCRIBE", params: ["!markPrice@arr", "btcusdt@depth20@100ms", "ethusdt@depth20@100ms"], id: 1 }]);
    } finally {
      ingest.stop();
      h.stop();
    }
    expect(fw.active()).toEqual([]);
  });

  test("drop-in-files", async () => {
    const { discoverJobs } = await import(join(WORKERS, "runner.ts"));
    const jobs = (await discoverJobs()) as { name: string; queue: string; schedule?: { every?: number } }[];
    const j = jobs.find((x) => x.name === "ingest-aster")!;
    expect(j.queue).toBe("fundingTick");
    expect(j.schedule).toEqual({ every: 60_000 });
    const mod = await import(join(WORKERS, "jobs/ingest-aster.job.ts"));
    expect(await mod.routedAsterSymbols({ db: null })).toEqual([]);
    const { loadSources } = await import(join(WORKERS, "jobs/catalog-sync.job.ts"));
    const sources = (await loadSources()) as { venue: string }[];
    expect(sources.map((s) => s.venue)).toContain("aster");
  });

  dbTest(
    "catalog-sync-and-routed",
    async () => {
      const t = await createTempDatabase(BASE!, { migrated: true, prefix: "capstan_aster" });
      const db = createDb(t.url, { max: 4 });
      const h = harness();
      try {
        const { asterSource } = await import(join(WORKERS, "jobs/catalog-sources/aster.source.ts"));
        const report = await syncMarkets(db, [asterSource(() => h.reader)], new Date("2026-11-06T00:00:00Z"));
        expect(report.errors).toEqual([]);
        expect(report.added.length).toBe(644);
        const rows = await db.select().from(schema.markets);
        expect(rows.every((r) => r.executable === false)).toBe(true);
        expect(rows.filter((r) => r.assetClassHint === "EQ").length).toBeGreaterThanOrEqual(150);
        // nothing executable yet: no depth streams
        const mod = await import(join(WORKERS, "jobs/ingest-aster.job.ts"));
        expect(await mod.routedAsterSymbols({ db })).toEqual([]);
        // BTCUSDT is TRADING; PTBUSDT is SETTLING (reduce-only), so it never gets a depth stream
        await db.$client`update markets set executable = true where id in ('aster:-:BTCUSDT', 'aster:-:PTBUSDT')`;
        expect(await mod.routedAsterSymbols({ db })).toEqual(["BTCUSDT"]);
        // a second sync on the same data changes nothing
        const again = await syncMarkets(db, [asterSource(() => h.reader)], new Date("2026-11-06T00:00:00Z"));
        expect(again.added.length + again.delisted.length).toBe(0);
      } finally {
        h.stop();
        await closeDb(db);
        await t.drop();
      }
    },
    60_000,
  );
});
