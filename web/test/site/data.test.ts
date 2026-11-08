// The site's data wiring (src/site/data.ts, feature.ts, dashboard.tsx): the API reads, the state model every live
// view uses (loading, ok, empty, error, offline), the formatting, and the values that replace the owner's placeholders.
import { describe, expect, test } from "bun:test";
import { assetsOf, bookStats, builderFeeBps, builderFeeUsd, createReader, fmtBps, fmtClock, fmtInterval, fmtPrice, fmtRatePct, fmtUntil, listMarkets, readBook, readFunding, readHealth, readLive, readQuote, readVenues, escapeHtml } from "../../src/site/data";
import { DEFAULT_QUOTE, loadMarketsData, marketsDetailValues, quotesDetailValues, riskDetailValues } from "../../src/site/feature";
import { loadDashData, overviewNumbers, priceMarketFor } from "../../src/site/dashboard";
import { riskSummary } from "../../src/site/react";
import { SAMPLE_QUOTE, SAMPLE_RISK } from "../../src/app/samples";
import { book, MARKETS, NOW, stubApi, VENUES } from "./stub-api";

const reader = (s = stubApi()) => ({ s, r: createReader({ apiBase: "http://api.test/v1/", fetch: s.fetch }) });

describe("site data", () => {
  test("reads", async () => {
    const { s, r } = reader();
    expect(r.base).toBe("http://api.test/v1");
    expect((await listMarkets(r)).length).toBe(MARKETS.length);
    await listMarkets(r, { venue: "hyperliquid", asset: "CR:BTC", executable: true });
    expect(s.calls.at(-1)).toBe("GET /markets?venue=hyperliquid&asset=CR%3ABTC&executable=true");
    expect((await readBook(r, "hyperliquid:-:BTC", 5)).bids.length).toBe(2);
    expect(s.calls.at(-1)).toBe("GET /markets/hyperliquid%3A-%3ABTC/book?depth=5");
    expect((await readFunding(r, "CR:BTC")).rows.length).toBe(3);
    expect(s.calls.at(-1)).toBe("GET /funding?asset=CR%3ABTC");
    expect((await readVenues(r)).length).toBe(4);
    expect(await readHealth(r)).toBe(true);
    const q = await readQuote(r, DEFAULT_QUOTE);
    expect(q.legs.length).toBe(3);
    expect(s.calls.at(-1)).toBe("POST /quote");
  });

  test("states", async () => {
    const { s, r } = reader();
    expect((await readLive(() => listMarkets(r), { isEmpty: (m) => m.length === 0 })).kind).toBe("ok");
    s.mode = "empty";
    expect(await readLive(() => listMarkets(r), { isEmpty: (m) => m.length === 0 })).toEqual({ kind: "empty" });
    s.mode = "error";
    expect(await readLive(() => listMarkets(r))).toEqual({ kind: "error", message: "the database is down" });
    s.mode = "down";
    expect(await readLive(() => listMarkets(r))).toEqual({ kind: "offline" });
    // a browser that says it is offline is offline, whatever the error
    s.mode = "error";
    expect(await readLive(() => listMarkets(r), { online: () => false })).toEqual({ kind: "offline" });
    // a call that never answers gives up (offline), never hangs the view
    const slow = createReader({ apiBase: "http://api.test/v1", timeoutMs: 20, fetch: ((_u: string, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch });
    expect(await readLive(() => readHealth(slow))).toEqual({ kind: "offline" });
  });

  test("derived values", () => {
    // perps only, majors first
    expect(assetsOf(MARKETS)).toEqual(["CR:BTC", "CR:ETH", "CR:SOL", "EQ:TSLA"]);
    const st = bookStats(book("hyperliquid:-:BTC"));
    expect(st.bestBid).toBe(100000);
    expect(st.bestAsk).toBe(100010);
    expect(st.mid).toBe(100005);
    expect(st.spreadBps).toBeCloseTo(0.99995, 4);
    expect(st.bidDepth).toBe(3.5);
    expect(bookStats({ marketId: "x", bids: [], asks: [], asOf: "" }).mid).toBeNull();
    // the builder fee comes from GET /venues; Lighter is 0, a data-only venue has none
    expect(builderFeeBps(VENUES, "hyperliquid")).toBe(2);
    expect(builderFeeBps(VENUES, "lighter-mainnet")).toBe(0);
    expect(builderFeeBps(VENUES, "variational")).toBeNull();
    expect(builderFeeUsd(10_000, 2)).toBe(2);
    // the dashboard numbers: never a total across venues
    const n = overviewNumbers({ markets: MARKETS, venues: VENUES });
    expect(n).toEqual({ marketsTracked: 6, venuesWithMarkets: 3, executionVenues: 3 });
    expect(Object.keys(n).some((k) => /margin|collateral|equity/i.test(k))).toBe(false);
    expect(priceMarketFor(MARKETS, "CR:BTC")?.id).toBe("hyperliquid:-:BTC");
    expect(priceMarketFor(MARKETS, "CR:DOGE")).toBeNull();
  });

  test("formatting", () => {
    expect(fmtPrice(100005)).toBe("100,005.00");
    expect(fmtPrice("3.5")).toBe("3.50");
    expect(fmtPrice(null)).toBe("n/a");
    expect(fmtRatePct("0.0000125")).toBe("0.0013%");
    expect(fmtRatePct(0.1095, 2)).toBe("10.95%");
    expect(fmtBps(2)).toBe("2 bps");
    expect(fmtBps(1.234)).toBe("1.23 bps");
    expect(fmtInterval(3600)).toBe("every hour");
    expect(fmtInterval(28800)).toBe("every 8 hours");
    expect(fmtUntil("2026-11-08T13:00:00Z", NOW)).toBe("1 h 00 min");
    expect(fmtUntil("2026-11-08T12:10:00Z", NOW)).toBe("10 min");
    expect(fmtUntil("2026-11-08T11:00:00Z", NOW)).toBe("due now");
    expect(fmtClock("2026-11-08T13:00:00Z")).toBe("13:00 UTC");
    expect(escapeHtml(`<b a="1">'x'&</b>`)).toBe("&lt;b a=&quot;1&quot;&gt;&#39;x&#39;&amp;&lt;/b&gt;");
  });

  test("placeholder values", async () => {
    const { r } = reader();
    const d = await loadMarketsData(r, null);
    expect(d.asset).toBe("CR:BTC");
    expect(d.book?.marketId).toBe("hyperliquid:-:BTC");
    // the five markets tabs, three live values each (the owner's "01 02 03" placeholders)
    expect(marketsDetailValues(d, 0, NOW)).toEqual(["BTC", "USDC", "BTC"]);
    expect(marketsDetailValues(d, 1, NOW)).toEqual(["100,000.00", "100,010.00", "3.5 / 4"]);
    expect(marketsDetailValues(d, 2, NOW)[0]).toBe("100,005.00 (book mid)");
    expect(marketsDetailValues(d, 3, NOW)).toEqual(["0.0013%", "10.95%", "every hour"]);
    expect(marketsDetailValues(d, 4, NOW)).toEqual(["Hyperliquid", "13:00 UTC", "1 h 00 min"]);
    for (let i = 0; i < 5; i++) expect(marketsDetailValues(d, i, NOW).length).toBe(3);
    // an unknown asset falls back to the first listed one
    expect((await loadMarketsData(r, "CR:NOPE")).asset).toBe("CR:BTC");
    expect((await loadMarketsData(r, "CR:ETH")).asset).toBe("CR:ETH");

    // quotes: the best executable leg, each cost on its own
    const q = quotesDetailValues(SAMPLE_QUOTE, 0, VENUES);
    expect(q).toEqual(["Hyperliquid", "venue schedule", "4.50 bps"]);
    expect(quotesDetailValues(SAMPLE_QUOTE, 1, VENUES)).toEqual(["Hyperliquid", "approved once per venue", "2 bps"]);
    expect(quotesDetailValues(SAMPLE_QUOTE, 2, VENUES)[2]).toBe("1.50 bps");
    expect(quotesDetailValues(SAMPLE_QUOTE, 3, VENUES)).toEqual(["1 bps per hour", "24 hours", "24 bps"]);
    expect(quotesDetailValues(SAMPLE_QUOTE, 4, VENUES)[2]).toBe("452.10");

    // risk: per venue, from the first account with a position; without a wallet it asks for one
    expect(riskDetailValues(null, 0)).toEqual(["connect a wallet", "connect a wallet", "connect a wallet"]);
    const sum = riskSummary(SAMPLE_RISK)!;
    expect(sum.venue).toBe("Hyperliquid");
    expect(riskDetailValues(sum, 0)).toEqual(["Hyperliquid", "2 TSLA", "short"]);
    expect(riskDetailValues(sum, 1)).toEqual(["$1,500.00", "$700.00", "0.12"]);
    expect(riskDetailValues(sum, 2)[2]).toBe("452.10");
    expect(riskSummary({ ...SAMPLE_RISK, perVenue: [] })).toBeNull();
  });

  test("dashboard data", async () => {
    const { r } = reader();
    const d = await loadDashData(r);
    expect(d.markets.length).toBe(MARKETS.length);
    expect(d.venues.length).toBe(4);
  });
});
