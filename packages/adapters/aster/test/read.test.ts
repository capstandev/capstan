// Aster read adapter rules R1, R4, R5, R7, R9, R11 (todo 13). Fixtures are live read-only captures (2026-11-06).
import { proposeCanonical } from "@capstan/catalog";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isEquityPerp, isExecutableCandidate, mapStatus, normalizeMarket } from "../src/normalize";
import { AsterUnknownError } from "../src/read";
import { defaultRoutes, exchangeInfo, harness, json, recordingGovernor } from "./helpers";

describe("aster read", () => {
  test("status-mapping", async () => {
    expect(mapStatus("TRADING", "PERPETUAL")).toBe("active");
    expect(mapStatus("SETTLING", "PERPETUAL")).toBe("reduce_only");
    expect(mapStatus("PENDING_TRADING", "")).toBe("unknown");
    expect(mapStatus("CLOSE", "PERPETUAL")).toBe("delisted");
    const h = harness();
    try {
      const ms = await h.reader.listMarkets();
      expect(ms.length).toBe(644);
      const by = (st: string) => ms.filter((m) => m.status === st);
      expect(by("active").length).toBe(596);
      expect(by("reduce_only").length).toBe(42);
      expect(by("unknown").length).toBe(6);
      // PENDING_TRADING rows have an empty contractType: never a perp, never executable
      for (const m of by("unknown")) {
        expect(m.marketType).toBe("other");
        expect(isExecutableCandidate(m)).toBe(false);
      }
      for (const m of by("reduce_only")) expect(isExecutableCandidate(m)).toBe(false);
      // every candidate is a TRADING, non-stock perp; the sync still enters them non-executable
      const cands = ms.filter(isExecutableCandidate);
      expect(cands.length).toBe(596 - ms.filter((m) => m.status === "active" && m.isEquity).length);
      expect(ms.every((m) => m.executable === false)).toBe(true);
    } finally {
      h.stop();
    }
  });

  test("margin-asset", async () => {
    const h = harness();
    try {
      const ms = await h.reader.listMarkets();
      const get = (s: string) => ms.find((m) => m.venueSymbol === s)!;
      expect(get("BTCUSDT").collateralAsset).toBe("USDT");
      expect(get("ETHUSD1").collateralAsset).toBe("USD1");
      expect(get("BTCUSDC").collateralAsset).toBe("USDC");
      expect(get("BTCU").collateralAsset).toBe("U");
      const counts: Record<string, number> = {};
      for (const m of ms) counts[m.collateralAsset] = (counts[m.collateralAsset] ?? 0) + 1;
      expect(counts).toEqual({ USDT: 612, USD1: 27, USDC: 3, U: 2 });
      // filters land in the canonical fields
      const btc = get("BTCUSDT");
      const raw = exchangeInfo().symbols.find((s) => s.symbol === "BTCUSDT")!;
      expect(btc.tickSize).toBe(raw.filters.find((f) => f.filterType === "PRICE_FILTER")!.tickSize!);
      expect(btc.lotSize).toBe(raw.filters.find((f) => f.filterType === "LOT_SIZE")!.stepSize!);
      expect(btc.minNotional).toBe(raw.filters.find((f) => f.filterType === "MIN_NOTIONAL")!.notional!);
      expect(btc.builderFeeUnit).toBe("decimal_rate");
      expect(btc.marketType).toBe("perp");
      expect(btc.fundingIntervalS).toBe(btc.fundingSettleIntervalS);
    } finally {
      h.stop();
    }
  });

  test("stock-perps-flagged", async () => {
    const raw = exchangeInfo().symbols;
    // underlyingType is COIN on every symbol, so it can never be the stock signal
    expect(raw.every((s) => s.underlyingType === "COIN")).toBe(true);
    expect(raw.filter((s) => s.symbolType === 1).length).toBe(150);
    const h = harness();
    try {
      const ms = await h.reader.listMarkets();
      const eq = ms.filter((m) => m.isEquity);
      expect(eq.length).toBe(raw.filter(isEquityPerp).length);
      expect(eq.length).toBeGreaterThanOrEqual(150);
      for (const s of ["AAPLUSDT", "TSLAUSDT", "NVDAUSD1"]) {
        const m = ms.find((x) => x.venueSymbol === s)!;
        expect(m.isEquity).toBe(true);
        expect(m.assetClassHint).toBe("EQ");
        expect(m.canonicalAsset).toBeNull();
        expect(isExecutableCandidate(m)).toBe(false);
        // the catalog rule proposes EQ:<base> for review, never an automatic map
        const p = proposeCanonical(m);
        expect(p.auto).toBe(false);
      }
      for (const m of eq) {
        expect(m.canonicalAsset).toBeNull();
        expect(proposeCanonical(m).auto).toBe(false);
      }
    } finally {
      h.stop();
    }
  });

  test("v3-only", async () => {
    // every path the source names is /fapi/v3; no V1 or spot path appears anywhere in src
    const dir = join(import.meta.dir, "../src");
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text.includes("/fapi/v1")).toBe(false);
      expect(text.includes("/fapi/v2")).toBe(false);
      expect(text.includes("/sapi/")).toBe(false);
      for (const m of text.matchAll(/["'`](\/fapi\/[a-z0-9]+)\//g)) expect(m[1]).toBe("/fapi/v3");
    }
    // live behaviour: a fake that answers V1 too; the reader only ever hits V3
    const routes = defaultRoutes();
    for (const k of Object.keys(routes)) routes[k.replace("/fapi/v3/", "/fapi/v1/")] = routes[k]!;
    const h = harness(routes);
    try {
      await h.reader.listMarkets();
      await h.reader.getBook("aster:-:BTCUSDT", 20);
      await h.reader.getFunding("aster:-:BTCUSDT");
      await h.reader.allFunding();
      expect(h.server.hits.length).toBeGreaterThan(0);
      expect(h.server.hits.every((x) => x.startsWith("GET /fapi/v3/"))).toBe(true);
    } finally {
      h.stop();
    }
  });

  test("503-and-418", async () => {
    // 503 = status unknown: retried after backoff, then reported as unknown (never as "no data")
    let n = 0;
    const sleeps: number[] = [];
    const flaky = harness(
      defaultRoutes({
        "GET /fapi/v3/depth": () => (++n < 3 ? new Response("", { status: 503 }) : json({ lastUpdateId: 7, E: 1, T: 2, bids: [["1", "1"]], asks: [["2", "1"]] })),
      }),
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    try {
      const b = await flaky.reader.getBook("aster:-:BTCUSDT", 5);
      expect(b.bids[0]).toEqual(["1", "1"]);
      expect(n).toBe(3);
      expect(sleeps.length).toBe(2);
      expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
    } finally {
      flaky.stop();
    }
    const down = harness(defaultRoutes({ "GET /fapi/v3/depth": () => new Response("", { status: 503 }) }));
    try {
      const e = await down.reader.getBook("aster:-:BTCUSDT").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AsterUnknownError);
      expect((e as AsterUnknownError).outcome).toBe("unknown");
    } finally {
      down.stop();
    }
    // 418 = ban: the governor stops every later Aster read, nothing more is sent
    const gov = recordingGovernor();
    const banned = harness(defaultRoutes({ "GET /fapi/v3/depth": () => json({ code: -1003, msg: "banned" }, 418) }), { gov });
    try {
      const e1 = await banned.reader.getBook("aster:-:BTCUSDT").catch((x: unknown) => x);
      expect((e1 as { code?: string }).code).toBe("VENUE_RATE_LIMITED");
      await gov.flush();
      const hitsAfterBan = banned.server.hits.length;
      const e2 = await banned.reader.getFunding("aster:-:BTCUSDT").catch((x: unknown) => x);
      expect((e2 as { code?: string }).code).toBe("VENUE_RATE_LIMITED");
      const e3 = await banned.reader.listMarkets().catch((x: unknown) => x);
      expect((e3 as { code?: string }).code).toBe("VENUE_RATE_LIMITED");
      expect(banned.server.hits.length).toBe(hitsAfterBan);
      expect(gov.usage("aster").bannedUntil).not.toBeNull();
    } finally {
      banned.stop();
    }
  });

  test("symbols", async () => {
    const h = harness();
    try {
      const ms = await h.reader.listMarkets();
      const btc = ms.find((m) => m.venueSymbol === "BTCUSDT")!;
      expect(btc.id).toBe("aster:-:BTCUSDT"); // the id keeps the venue symbol
      expect(btc.dex).toBeNull();
      expect(btc.canonicalAsset).toBeNull(); // the adapter never maps
      expect(proposeCanonical(btc)).toMatchObject({ asset: "CR:BTC", auto: true }); // only the 03 majors rule does
      const eth1 = ms.find((m) => m.venueSymbol === "ETHUSD1")!;
      expect(proposeCanonical(eth1)).toMatchObject({ asset: "CR:ETH", auto: true });
      const aster = ms.find((m) => m.venueSymbol === "ASTERUSDT")!;
      expect(proposeCanonical(aster).auto).toBe(false); // not a major: review
      // a symbol missing from fundingInfo defaults to 8 h, and ids are stable across calls
      const raw = exchangeInfo().symbols[0]!;
      expect(normalizeMarket(raw, undefined, "2026-01-01T00:00:00.000Z").fundingIntervalS).toBe(28800);
      const again = await h.reader.listMarkets();
      expect(again.map((m) => m.id)).toEqual(ms.map((m) => m.id));
    } finally {
      h.stop();
    }
  });
});
