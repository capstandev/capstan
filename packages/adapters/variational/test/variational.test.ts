// Variational read-only adapter rules R1 to R4 (todo 16), on recorded live fixtures.
import { describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import { createMemoryGovernor, DEFAULT_429_MS, fakeVenueServer, venueHttp } from "@capstan/venue-client";
import { createVariationalAdapter, POLL_MS, STATS_PATH, variationalHttp } from "../src/adapter";
import { annualisedOf, classHint, isoMs, normalizeFunding, ratePerHourOf, variationalMarketId } from "../src/normalize";
import { fakeClock, json, rateLimitedBody, stats } from "./helpers";

describe("variational", () => {
  test("rate", async () => {
    // 10 minutes simulated with callers hammering the adapter every 50 ms and no adapter-side cache: the governor alone
    // must hold the venue to at most 10 requests in any 10 s window (it stops at 80%, so 8).
    const clock = fakeClock();
    const gov = createMemoryGovernor("rate", { now: clock.now, sleep: clock.sleep });
    const at: number[] = [];
    const fetchImpl = (async () => {
      at.push(clock.t);
      return json(stats());
    }) as unknown as typeof fetch;
    const http = venueHttp("variational", "http://variational.invalid", gov, { fetchImpl });
    const a = createVariationalAdapter(http, null, { now: clock.now, minGapMs: 0 });
    const end = clock.t + 600_000;
    while (clock.t < end) {
      await a.snapshot(true);
      clock.t += 50;
    }
    expect(at.length).toBeGreaterThan(400); // the loop really pressed the limit (8 per 10 s over 600 s = 480)
    let worst = 0;
    for (let i = 0; i < at.length; i++) {
      let j = i;
      while (j < at.length && at[j]! < at[i]! + 10_000) j++;
      worst = Math.max(worst, j - i);
    }
    expect(worst).toBeLessThanOrEqual(10);
    expect(worst).toBe(8);

    // with the default 30 s poll gap the adapter itself fetches about twice a minute, whatever the callers do
    const c2 = fakeClock();
    const g2 = createMemoryGovernor("rate2", { now: c2.now, sleep: c2.sleep });
    let n = 0;
    const f2 = (async () => {
      n++;
      return json(stats());
    }) as unknown as typeof fetch;
    const a2 = createVariationalAdapter(venueHttp("variational", "http://variational.invalid", g2, { fetchImpl: f2 }), null, { now: c2.now });
    const end2 = c2.t + 600_000;
    while (c2.t < end2) {
      await a2.getFunding(variationalMarketId("BTC-PERP"));
      await a2.listMarkets();
      c2.t += 100;
    }
    expect(n).toBe(600_000 / POLL_MS);
    expect(a2.fetches()).toBe(n);
  });

  test("retry-body", async () => {
    // The global 429 carries its hint only in the body (retry_after_seconds, no Retry-After header). The recorded body
    // says 1 s, under the governor's 2 s default, so this test sends 4 s: only a read of the body can explain a 4 s wait.
    // A fake governor clock records every wait: the retry is held for exactly 4000 ms.
    expect(4000).toBeGreaterThan(DEFAULT_429_MS);
    const run = async (body: unknown) => {
      let calls = 0;
      const srv = fakeVenueServer({ [`GET ${STATS_PATH}`]: () => (++calls === 1 ? json(body, 429) : json(stats())) });
      try {
        const clock = { t: 1_793_929_000_000 };
        const waits: number[] = [];
        const gov = createMemoryGovernor("retry-body", { now: () => clock.t, sleep: async (ms) => void (waits.push(ms), (clock.t += ms)) });
        const a = createVariationalAdapter(variationalHttp(gov, { backoffBaseMs: 1 }, srv.url), memoryMarketDataCache());
        const t0 = clock.t;
        const ms = await a.listMarkets();
        expect(calls).toBe(2);
        expect(ms.length).toBe(stats().listings.length);
        return { waited: clock.t - t0, waits };
      } finally {
        srv.stop();
      }
    };
    const recorded = rateLimitedBody();
    expect(recorded.retry_after_seconds).toBe(1); // the live shape: a number of seconds in the body
    const hinted = await run({ ...recorded, message: "Service is busy; try again in 4 seconds", retry_after_seconds: 4 });
    expect(hinted.waits).toContain(4000);
    expect(hinted.waited).toBeGreaterThanOrEqual(4000);
    // the recorded 1 s body is honoured too: 1000 ms, not the 2000 ms default
    const live = await run(recorded);
    expect(live.waits).toContain(1000);
    expect(live.waits).not.toContain(DEFAULT_429_MS);
    // control: with no hint the same path waits the default, so the waits above came from the body
    const bare = await run({ error: "rate_limited" });
    expect(bare.waits).toContain(DEFAULT_429_MS);
    expect(bare.waits).not.toContain(4000);
  });

  test("funding-normalise", () => {
    // 0.00005 per 4 h interval: 0.0000125 per hour, annualised 0.1095, equal to the venue's annualized_rate
    expect(ratePerHourOf("0.00005", 14_400)).toBe("0.0000125");
    expect(annualisedOf("0.0000125")).toBe("0.1095");
    const l = stats().listings.find((x) => x.funding.interval_seconds === 14_400 && x.funding.last.interval_rate === "0.000050")!;
    // a 24 h swap carries long and short rates and no next: the long side is kept, the next boundary is computed
    const sw = normalizeFunding(stats().listings.find((x) => x.ticker === "XAU-SWAP")!, "2026-11-06T01:52:59.000Z");
    expect(sw).toMatchObject({ ratePerInterval: "0.0001544", intervalS: 86_400, predictedNext: null, nextSettlementAt: "2026-11-07T00:00:00.000Z" });
    expect(l).toBeDefined();
    const f = normalizeFunding(l);
    expect(f.ratePerHour).toBe("0.0000125");
    expect(f.rateAnnualised).toBe("0.1095");
    expect(Number(f.rateAnnualised)).toBe(Number(l.funding.last.annualized_rate!));
    expect(f.intervalS).toBe(14_400);
    expect(f.nextSettlementAt).toBe(new Date(l.funding.next_timestamp! * 1000).toISOString()); // next_timestamp is seconds
    // every recorded listing: our annualised equals the venue's simple annualised rate, on every cadence, to the
    // precision the venue prints it with (it rounds to 6 decimals)
    // (perps only: the swaps annualise their long and short rates on a 360-day year, so they are not compared)
    for (const x of stats().listings.filter((l) => l.contract_type === "perpetual")) {
      const s = normalizeFunding(x, "2026-11-06T00:00:00.000Z");
      const printed = x.funding.last.annualized_rate!;
      const decimals = (printed.split(".")[1] ?? "").length;
      expect(Math.abs(Number(s.rateAnnualised) - Number(printed))).toBeLessThanOrEqual(10 ** -decimals + 1e-12);
    }
    // the cadences in the fixture really differ (1 h, 4 h, 8 h, 24 h swaps)
    expect(new Set(stats().listings.map((x) => x.funding.interval_seconds)).size).toBeGreaterThanOrEqual(3);
  });

  test("delayed-label", async () => {
    const clock = fakeClock(Date.parse("2026-11-06T01:53:30Z"));
    const fetchImpl = (async () => json(stats())) as unknown as typeof fetch;
    const http = venueHttp("variational", "http://variational.invalid", createMemoryGovernor("dl"), { fetchImpl });
    const a = createVariationalAdapter(http, null, { now: clock.now });
    const ms = await a.listMarkets();
    expect(ms.length).toBeGreaterThan(30);
    for (const m of ms) {
      expect(m.dataFreshness).toBe("delayed");
      expect(m.executable).toBe(false);
      expect(m.venue).toBe("variational");
    }
    // swaps are 'other', perps are 'perp'; non-crypto tickers carry a class hint and never auto-map
    expect(ms.find((m) => m.venueSymbol === "XAU-SWAP")!.marketType).toBe("other");
    expect(ms.find((m) => m.venueSymbol === "BTC-PERP")!.marketType).toBe("perp");
    for (const t of ["QQQ-PERP", "US500-PERP", "XAU-PERP", "ASML-PERP"]) expect(classHint(t)).not.toBeNull();
    expect(classHint("BTC-PERP")).toBeNull();
    // asOf is the quote's updated_at, not the fetch time
    const btc = stats().listings.find((l) => l.ticker === "BTC-PERP")!;
    const f = await a.getFunding(variationalMarketId("BTC-PERP"));
    expect(f.asOf).toBe(isoMs(btc.quotes!.updated_at));
    expect(f.asOf).not.toBe(new Date(clock.t).toISOString());
    const mark = await a.getMark(variationalMarketId("BTC-PERP"));
    expect(mark).toEqual({ mark: btc.mark_price, asOf: isoMs(btc.quotes!.updated_at) });
    const buckets = await a.getQuoteBuckets(variationalMarketId("BTC-PERP"));
    expect(buckets.map((b) => b.size).slice(0, 2)).toEqual(["1k", "100k"]);
    expect(buckets.every((b) => b.asOf === f.asOf)).toBe(true);
    expect(await a.getBook(variationalMarketId("BTC-PERP"))).toBeNull();
    // nanosecond RFC 3339 keeps its milliseconds
    expect(isoMs("2026-11-06T01:52:33.181218059Z")).toBe("2026-11-06T01:52:33.181Z");
  });

  test("stream delivers only new snapshots", async () => {
    const clock = fakeClock();
    let rev = 0;
    const fetchImpl = (async () => {
      const s = stats();
      if (rev > 0) for (const l of s.listings) if (l.quotes) l.quotes.updated_at = `2026-11-06T02:00:0${rev}.000Z`;
      return json(s);
    }) as unknown as typeof fetch;
    const http = venueHttp("variational", "http://variational.invalid", createMemoryGovernor("st"), { fetchImpl });
    let tick: () => void = () => {};
    const a = createVariationalAdapter(http, null, { now: clock.now, setInterval: (fn) => ((tick = fn), 1), clearInterval: () => {} });
    const ev: string[] = [];
    const stop = a.streamMarket([variationalMarketId("BTC-PERP")], (e) => ev.push(e.kind));
    await Bun.sleep(5);
    expect(ev).toEqual(["mark", "funding"]);
    clock.t += POLL_MS;
    tick(); // same CDN snapshot: nothing new
    await Bun.sleep(5);
    expect(ev.length).toBe(2);
    rev = 1;
    clock.t += POLL_MS;
    tick();
    await Bun.sleep(5);
    expect(ev.length).toBe(4);
    stop();
  });
});
