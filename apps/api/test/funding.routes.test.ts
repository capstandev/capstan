// R6, R7, R8, R10 (todo 18): funding routes.
import { afterAll, describe, expect, test } from "bun:test";
import { memoryCatalog, type Forecast, type QuoteMarket } from "@capstan/quote";
import { db as schema, type FundingSnapshot, type VenueId } from "@capstan/schema";
import { Hono } from "hono";
import { createFundingRoutes, dbHistoryReader, isPerRowsPriced, FORECAST_PRICE_USD, frozenWindow, HISTORY_PAGE_ROWS, HISTORY_PRICE_PER_1000_USD, historyPriceUsd, type FundingRouteDeps, type HistoryReader } from "../src/routes/funding.routes";

const PG = process.env.DATABASE_URL;
const NOW = Date.parse("2026-11-06T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function market(id: string, venue: VenueId, o: Partial<QuoteMarket> = {}): QuoteMarket {
  return { id, venue, dex: null, venueSymbol: id.split(":")[2]!, marketType: "perp", canonicalAsset: "CR:BTC", collateralAsset: "USDC", tickSize: "0.1", lotSize: "0.001", minNotional: null, maxLeverage: 20, marginModes: [], fundingIntervalS: 3600, fundingSettleIntervalS: 3600, sessionHours: null, oiCapUsd: null, builderFeeUnit: null, status: "active", executable: venue !== "variational" && venue !== "arcus", dataFreshness: venue === "variational" ? "delayed" : "live", updatedAt: iso(NOW), ...o };
}
const MARKETS = [market("hyperliquid:-:BTC", "hyperliquid"), market("aster:-:BTCUSDT", "aster", { fundingSettleIntervalS: 28_800 }), market("variational:-:BTC-PERP", "variational", { fundingSettleIntervalS: 14_400 }), market("arcus:-:BTC-USD", "arcus", { collateralAsset: "USDG" })];
const snap = (id: string, perHour: string, asOf: number, intervalS = 3600): FundingSnapshot => ({ marketId: id, ratePerInterval: perHour, intervalS, ratePerHour: perHour, rateAnnualised: String(Number(perHour) * 8760), predictedNext: null, nextSettlementAt: iso(NOW + 3600_000), capPerHour: null, source: "venue", asOf: iso(asOf) });

function app(history: HistoryReader | null = null, forecasts: Record<string, Forecast> = {}) {
  const funding = new Map<string, FundingSnapshot>([
    ["hyperliquid:-:BTC", snap("hyperliquid:-:BTC", "0.0000125", NOW - 2000)],
    ["aster:-:BTCUSDT", snap("aster:-:BTCUSDT", "0.0000125", NOW - 5000, 28_800)],
    ["variational:-:BTC-PERP", snap("variational:-:BTC-PERP", "0.0000125", NOW - 45_000, 14_400)],
    ["arcus:-:BTC-USD", snap("arcus:-:BTC-USD", "0.0000125", NOW - 3000)],
  ]);
  const deps: FundingRouteDeps = { catalog: memoryCatalog(MARKETS), cache: { getFunding: async (id) => funding.get(id) ?? null }, forecasts: { get: async (id) => forecasts[id] ?? null }, history, now: () => NOW };
  const routes = createFundingRoutes(() => deps);
  const h = new Hono();
  for (const r of routes) h.on(r.method, `/v1${r.path}`, (c) => r.handler(c));
  return { h, routes };
}


/**
 * Mount /history/funding behind a stand-in x402 gate: it calls priceRequest(c) on the request, then runs `between`
 * (a clock move and writes landing after pricing), then hands the same request to the handler.
 */
function gated(history: HistoryReader, clock: { now: number }, between: () => Promise<void>) {
  const deps: FundingRouteDeps = { catalog: memoryCatalog(MARKETS), cache: { getFunding: async () => null }, forecasts: { get: async () => null }, history, now: () => clock.now };
  const hist = createFundingRoutes(() => deps).find((r) => r.path === "/history/funding")!;
  if (!isPerRowsPriced(hist)) throw new Error("history must be priced per rows");
  const charged: { usd: string; rows: number }[] = [];
  const h = new Hono();
  h.get("/v1/history/funding", async (c, next) => {
    const p = await hist.priceRequest(c);
    if ("error" in p) return c.json({ error: p.error }, 400);
    charged.push(p);
    await between();
    await next();
  });
  h.get("/v1/history/funding", (c) => hist.handler(c));
  return { h, charged };
}
type Delivered = { rows: { ts: string; ratePerHour: string }[]; window: { to: string }; charged: { rows: number; usd: string } };

/** An in-memory reader over a mutable row list (same window, cursor and cap rules as dbHistoryReader). */
function memoryReader(all: { ts: string; ratePerHour: string }[]): HistoryReader {
  return {
    async page(marketId, from, to, cursor, opts = {}) {
      const inWin = all.filter((r) => Date.parse(r.ts) >= from.getTime() && Date.parse(r.ts) <= to.getTime() && (!cursor || Date.parse(r.ts) > cursor.getTime())).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      const rows = inWin.slice(0, Math.min(HISTORY_PAGE_ROWS, opts.maxRows ?? HISTORY_PAGE_ROWS)).map((r) => ({ ...r, marketId, ratePerInterval: r.ratePerHour, intervalS: 3600, rateAnnualised: "0", source: "venue" }));
      return { window: { from: iso(from.getTime()), to: iso(to.getTime()) }, totalRows: inWin.length, rows, pricing: { rows: rows.length, usd: historyPriceUsd(rows.length), perThousandUsd: "0.05" }, nextCursor: inWin.length > rows.length ? rows[rows.length - 1]!.ts : null };
    },
  };
}

describe("funding routes", () => {
  test("all-venues-labelled", async () => {
    const { h } = app();
    const res = await h.request("/v1/funding?asset=CR:BTC");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { note: string; rows: { venue: string; source: string; asOf: string; dataFreshness: string; annualisedLabel: string; note: string }[] };
    expect(j.rows.map((r) => r.venue).sort()).toEqual(["arcus", "aster", "hyperliquid", "variational"]); // data-only included
    for (const r of j.rows) {
      expect(r.source).toBe("venue");
      expect(typeof r.asOf).toBe("string");
      expect(r.annualisedLabel).toBe("observed, annualised");
      expect(r.note).toContain("observed");
    }
    expect(j.rows.find((r) => r.venue === "variational")!.dataFreshness).toBe("delayed");
    expect(j.note).toContain("observed");
    // no copy calls a rate a return of any kind
    expect(JSON.stringify(j)).not.toMatch(/yield|apy|apr|earn|profit|guarantee/i);
    expect((await h.request("/v1/funding?asset=nope")).status).toBe(400);
  });

  test("priced", async () => {
    const { routes } = app();
    const f = routes.find((r) => r.path === "/funding/forecast")!;
    const hist = routes.find((r) => r.path === "/history/funding")!;
    const pub = routes.find((r) => r.path === "/funding")!;
    expect(f).toMatchObject({ method: "GET", auth: "x402", priced: { usd: "0.01" } });
    // history is priced per 1,000 rows, so its spec says so and carries the per-request price (never a flat $0.05)
    expect(hist).toMatchObject({ method: "GET", auth: "x402", priced: { usd: "0.05", perRows: 1000 } });
    expect(isPerRowsPriced(hist)).toBe(true);
    expect(isPerRowsPriced(f)).toBe(false);
    expect(pub.auth).toBe("public");
    expect(FORECAST_PRICE_USD).toBe("0.01");
    expect(HISTORY_PRICE_PER_1000_USD).toBe("0.05");
    // the handler answers with the forecast the job cached
    const fc: Forecast = { marketId: "hyperliquid:-:BTC", settlements: [{ at: iso(NOW + 3600_000), predictedRatePerHour: "0.0000125", method: "venue" }] };
    const { h } = app(null, { "hyperliquid:-:BTC": fc });
    const j = (await (await h.request("/v1/funding/forecast?asset=CR:BTC")).json()) as { forecasts: { marketId: string; status: string }[] };
    expect(j.forecasts.find((x) => x.marketId === "hyperliquid:-:BTC")!.status).toBe("ok");
    expect(j.forecasts.find((x) => x.marketId === "aster:-:BTCUSDT")!.status).toBe("unavailable");
  });

  test("history-pricing", async () => {
    expect(historyPriceUsd(2500)).toBe("0.15");
    expect(historyPriceUsd(1000)).toBe("0.05");
    expect(historyPriceUsd(1001)).toBe("0.1");
    expect(historyPriceUsd(1)).toBe("0.05");
    expect(historyPriceUsd(0)).toBe("0");
    expect(historyPriceUsd(10_000)).toBe("0.5");
    expect(HISTORY_PAGE_ROWS).toBe(10_000);
    // a 12,000-row window is paged: 10,000 rows ($0.50) then 2,000 ($0.10)
    const all = Array.from({ length: 12_000 }, (_, i) => ({ ts: iso(NOW - (12_000 - i) * 60_000), marketId: "hyperliquid:-:BTC", ratePerInterval: "0.00001", intervalS: 3600, ratePerHour: "0.00001", rateAnnualised: "0.0876", source: "venue" }));
    const fake: HistoryReader = {
      async page(_m, from, to, cursor, opts = {}) {
        const inWin = all.filter((r) => Date.parse(r.ts) >= from.getTime() && Date.parse(r.ts) <= to.getTime() && (!cursor || Date.parse(r.ts) > cursor.getTime()));
        const rows = inWin.slice(0, Math.min(HISTORY_PAGE_ROWS, opts.maxRows ?? HISTORY_PAGE_ROWS));
        return { window: { from: iso(from.getTime()), to: iso(to.getTime()) }, totalRows: inWin.length, rows, pricing: { rows: rows.length, usd: historyPriceUsd(rows.length), perThousandUsd: "0.05" }, nextCursor: inWin.length > rows.length ? rows[rows.length - 1]!.ts : null };
      },
    };
    const { h, routes } = app(fake);
    const q = `/v1/history/funding?marketId=hyperliquid:-:BTC&from=${iso(NOW - 30 * 86_400_000)}&to=${iso(NOW + 86_400_000)}`;
    // what the x402 gate charges comes from priceRequest on the same query: $0.50 for the first page, $0.10 next
    const hist = routes.find((r) => r.path === "/history/funding")!;
    if (!isPerRowsPriced(hist)) throw new Error("history must be priced per rows");
    const gate = new Hono();
    gate.get("/v1/history/funding", async (c) => c.json(await hist.priceRequest(c)));
    expect(await (await gate.request(q)).json()).toEqual({ usd: "0.5", rows: 10_000 });
    const narrow = `/v1/history/funding?marketId=hyperliquid:-:BTC&from=${iso(NOW - 2500 * 60_000)}&to=${iso(NOW)}`;
    expect(await (await gate.request(narrow)).json()).toEqual({ usd: "0.15", rows: 2500 });
    expect(await (await gate.request("/v1/history/funding?marketId=hyperliquid:-:BTC&from=x&to=y")).json()).toHaveProperty("error");
    const r1 = await h.request(q);
    const p1 = (await r1.json()) as { rows: unknown[]; pricing: { usd: string; rows: number }; nextCursor: string; window: { to: string } };
    expect(p1.rows.length).toBe(10_000);
    expect(p1.pricing).toMatchObject({ rows: 10_000, usd: "0.5" });
    expect(r1.headers.get("x-capstan-price-usd")).toBe("0.5");
    expect(p1.window.to).toBe(iso(NOW)); // to is frozen at now when it lies in the future
    const r2 = await h.request(`${q}&cursor=${encodeURIComponent(p1.nextCursor)}`);
    const p2 = (await r2.json()) as { rows: unknown[]; pricing: { usd: string }; nextCursor: string | null };
    expect(p2.rows.length).toBe(2_000);
    expect(p2.pricing.usd).toBe("0.1");
    expect(p2.nextCursor).toBeNull();
    expect((await h.request("/v1/history/funding?marketId=hyperliquid:-:BTC&from=x&to=y")).status).toBe(400);
    expect(frozenWindow(new Date(0), new Date(NOW + 1), NOW).to.getTime()).toBe(NOW);
  });

  test("priced-rows-equal-delivered gate-then-handler", async () => {
    // R10 across the two route functions: the gate prices 1,000 rows ($0.05), a minute passes and the per-minute
    // funding tick lands, then the handler delivers. It must deliver the 1,000 rows that were paid for, on the
    // window frozen at pricing time, never 1,001.
    const q = `/v1/history/funding?marketId=hyperliquid:-:BTC&from=${iso(NOW - 2 * 86_400_000)}&to=${iso(NOW + 86_400_000)}`;
    const base = () => Array.from({ length: 1000 }, (_, i) => ({ ts: iso(NOW - (1000 - i) * 60_000), ratePerHour: "0.00001" }));

    // a tick written after pricing, inside the window the handler would see on its own clock
    const clock = { now: NOW };
    const all = base();
    const tick = gated(memoryReader(all), clock, async () => {
      clock.now = NOW + 60_000;
      all.push({ ts: iso(NOW + 30_000), ratePerHour: "0.9" });
    });
    const r1 = await tick.h.request(q);
    expect(r1.status).toBe(200);
    const p1 = (await r1.json()) as Delivered;
    expect(tick.charged).toEqual([{ usd: "0.05", rows: 1000 }]);
    expect(p1.rows.length).toBe(1000);
    expect(p1.rows.some((r) => r.ratePerHour === "0.9")).toBe(false);
    expect(p1.window.to).toBe(iso(NOW)); // the window priced, not the handler's later clock
    expect(p1.charged).toEqual({ rows: 1000, usd: "0.05" });
    expect(r1.headers.get("x-capstan-price-usd")).toBe("0.05");

    // a backfilled row inside the frozen window: delivery is capped at the rows paid for
    const clock2 = { now: NOW };
    const all2 = base();
    const backfill = gated(memoryReader(all2), clock2, async () => {
      clock2.now = NOW + 60_000;
      all2.push({ ts: iso(NOW - 500 * 60_000 - 30_000), ratePerHour: "0.8" });
    });
    const p2 = (await (await backfill.h.request(q)).json()) as Delivered;
    expect(backfill.charged).toEqual([{ usd: "0.05", rows: 1000 }]);
    expect(p2.rows.length).toBe(1000); // not 1,001: a 1,001st row would cost a second $0.05
    expect(p2.charged).toEqual({ rows: 1000, usd: "0.05" });

    // with no gate in front the handler prices the request itself, on the same rules
    const { h } = app(memoryReader(base()));
    const p3 = (await (await h.request(q)).json()) as Delivered;
    expect(p3.rows.length).toBe(1000);
    expect(p3.charged).toEqual({ rows: 1000, usd: "0.05" });
  });
});

(PG ? describe : describe.skip)("funding history with a database", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of cleanups) await c();
  }, 30_000);
  test(
    "priced-rows-equal-delivered",
    async () => {
      const { createTempDatabase, createDb, closeDb } = await import("@capstan/core");
      const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_fh" });
      const db = createDb(t.url, { max: 3 });
      const other = createDb(t.url, { max: 1 });
      cleanups.push(async () => {
        await closeDb(db);
        await closeDb(other);
        await t.drop();
      });
      const id = "hyperliquid:-:BTC";
      const rows = Array.from({ length: 2500 }, (_, i) => ({ ts: new Date(NOW - (2500 - i) * 60_000), marketId: id, ratePerInterval: "0.00001", intervalS: 3600, ratePerHour: "0.00001", predictedNext: null, source: "venue" }));
      for (let i = 0; i < rows.length; i += 500) await db.insert(schema.fundingTicks).values(rows.slice(i, i + 500));
      const reader = dbHistoryReader(db);
      const w = frozenWindow(new Date(NOW - 10 * 86_400_000), new Date(NOW + 3600_000), NOW);
      // between pricing and delivery another writer adds a row inside the window and one after it
      const page = await reader.page(id, w.from, w.to, null, { afterPriced: async () => {
        await other.insert(schema.fundingTicks).values([
          { ts: new Date(NOW - 30_000), marketId: id, ratePerInterval: "0.9", intervalS: 3600, ratePerHour: "0.9", predictedNext: null, source: "venue" },
          // a backfilled row in the middle of the window: ordered by ts it falls inside the first 2,500, so only the
          // snapshot (not the row limit) keeps it out of a page priced before it existed
          { ts: new Date(NOW - 1234 * 60_000 - 30_000), marketId: id, ratePerInterval: "0.8", intervalS: 3600, ratePerHour: "0.8", predictedNext: null, source: "venue" },
          { ts: new Date(NOW + 60_000), marketId: id, ratePerInterval: "0.9", intervalS: 3600, ratePerHour: "0.9", predictedNext: null, source: "venue" },
        ]);
      } });
      expect(page.pricing).toMatchObject({ rows: 2500, usd: "0.15" });
      expect(page.rows.length).toBe(2500); // exactly the priced rows
      expect(page.rows.some((r) => r.ratePerHour === "0.9" || r.ratePerHour === "0.8")).toBe(false); // late rows are neither returned nor charged
      expect(page.rows.map((r) => r.ts)).toEqual(rows.map((r) => r.ts.toISOString())); // exactly the rows that were priced
      expect(page.window.to).toBe(iso(NOW));
      // the next request sees both new in-window rows and prices them (the future row stays out until its time)
      const again = await reader.page(id, w.from, w.to, null);
      expect(again.pricing).toMatchObject({ rows: 2502, usd: "0.15" });
      expect(again.rows.some((r) => r.ratePerHour === "0.8")).toBe(true);
    },
    30_000,
  );

  test(
    "priced-rows-equal-delivered through priceRequest then handler",
    async () => {
      // the verifier's repro on the real reader: price 1,000 rows, a minute passes, the funding tick and a backfill
      // land from another connection, then the handler serves the same request
      const { createTempDatabase, createDb, closeDb } = await import("@capstan/core");
      const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_fg" });
      const db = createDb(t.url, { max: 3 });
      const other = createDb(t.url, { max: 1 });
      cleanups.push(async () => {
        await closeDb(db);
        await closeDb(other);
        await t.drop();
      });
      const id = "hyperliquid:-:BTC";
      const tick = (ts: number, rate: string) => ({ ts: new Date(ts), marketId: id, ratePerInterval: rate, intervalS: 3600, ratePerHour: rate, predictedNext: null, source: "venue" });
      const rows = Array.from({ length: 1000 }, (_, i) => tick(NOW - (1000 - i) * 60_000, "0.00001"));
      for (let i = 0; i < rows.length; i += 500) await db.insert(schema.fundingTicks).values(rows.slice(i, i + 500));
      const clock = { now: NOW };
      let landed = false;
      const { h, charged } = gated(dbHistoryReader(db), clock, async () => {
        if (landed) return;
        landed = true;
        clock.now = NOW + 60_000;
        await other.insert(schema.fundingTicks).values([tick(NOW + 30_000, "0.9"), tick(NOW - 500 * 60_000 - 30_000, "0.8")]);
      });
      const q = `/v1/history/funding?marketId=${id}&from=${iso(NOW - 2 * 86_400_000)}&to=${iso(NOW + 86_400_000)}`;
      const res = await h.request(q);
      expect(res.status).toBe(200);
      const p = (await res.json()) as Delivered;
      expect(charged).toEqual([{ usd: "0.05", rows: 1000 }]);
      expect(p.rows.length).toBe(1000);
      expect(p.rows.some((r) => r.ratePerHour === "0.9")).toBe(false);
      expect(p.window.to).toBe(iso(NOW));
      expect(p.charged).toEqual({ rows: 1000, usd: "0.05" });
      expect(res.headers.get("x-capstan-price-usd")).toBe("0.05");
      // the next request prices and delivers both new in-window rows
      const again = (await (await h.request(q)).json()) as Delivered;
      expect(charged[1]).toEqual({ usd: "0.1", rows: 1002 });
      expect(again.rows.length).toBe(1002);
    },
    30_000,
  );
});
