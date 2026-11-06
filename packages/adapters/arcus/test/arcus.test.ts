// Arcus read-only adapter rules R5, R6, R7, R9 (todo 16), on recorded live fixtures.
import { describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import { arcusWeight, createMemoryGovernor, DEFAULT_429_MS, fakeVenueServer, venueHttp } from "@capstan/venue-client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCUS_BOOK_LEVELS, ARCUS_MAINNET, ARCUS_METADATA, ARCUS_POLL_MS, ARCUS_WEIGHT_PER_S, createArcusAdapter, type ArcusConfig } from "../src/adapter";
import { ARCUS_FIELD_UNITS, ARCUS_UNITS, arcusMarketId, fundingHistoryRow, normalizeFunding, normalizeMarket, type ArcusBbo, type ArcusBook, type ArcusFundingRow, type ArcusMarkets } from "../src/normalize";

const FIX = join(import.meta.dir, "fixtures");
const fx = <T>(n: string): T => (JSON.parse(readFileSync(join(FIX, `${n}.json`), "utf8")) as { response: T }).response;
const markets = () => fx<ArcusMarkets>("markets");
const json = (b: unknown, s = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...h } });
const fakeClock = (t0 = 1_793_929_000_000) => {
  const c = { t: t0, now: () => c.t, sleep: async (ms: number) => void (c.t += ms) };
  return c;
};

describe("arcus", () => {
  test("units", () => {
    // one contract per field; each value read live on 2026-11-06
    expect(Object.keys(ARCUS_FIELD_UNITS).sort()).toEqual(["addedTimestamp", "bbo.timestamp", "fundingRates[].time", "nextFundingAt", "timeNs"]);
    // nextFundingAt (seconds): BTC-USD 1793930400 is the next whole hour
    const btc = markets().markets.find((m) => m.marketDisplayName === "BTC-USD")!;
    expect(ARCUS_FIELD_UNITS.nextFundingAt).toBe("seconds");
    expect(new Date(ARCUS_UNITS.seconds(btc.nextFundingAt!)).toISOString()).toBe("2026-11-06T02:00:00.000Z");
    expect(normalizeFunding(btc, 1_793_929_049_000)!.nextSettlementAt).toBe("2026-11-06T02:00:00.000Z");
    // addedTimestamp (seconds)
    expect(new Date(ARCUS_UNITS.seconds(btc.addedTimestamp!)).getUTCFullYear()).toBe(2026);
    // fundingRates[].time (microseconds): rows are exactly one hour apart and fall on the hour
    const rows = fx<{ fundingRates: ArcusFundingRow[] }>("fundingRates_BTC-USD").fundingRates;
    expect(ARCUS_FIELD_UNITS["fundingRates[].time"]).toBe("micros");
    expect(ARCUS_UNITS.micros(rows[0]!.time) - ARCUS_UNITS.micros(rows[1]!.time)).toBe(3_600_000);
    expect(fundingHistoryRow(rows[0]!).ts).toBe("2026-11-06T01:00:00.000Z");
    // bbo.timestamp (microseconds)
    const bbo = fx<ArcusBbo>("bbo_BTC-USD");
    expect(ARCUS_FIELD_UNITS["bbo.timestamp"]).toBe("micros");
    expect(new Date(ARCUS_UNITS.micros(bbo.timestamp)).toISOString()).toBe("2026-11-06T01:37:29.636Z");
    // timeNs (nanoseconds), as GET /v1/time returns it; a string keeps full precision
    expect(ARCUS_FIELD_UNITS.timeNs).toBe("nanos");
    expect(ARCUS_UNITS.nanos("1793929049636463123")).toBe(1_793_929_049_636);
    expect(ARCUS_UNITS.nanos(1_793_929_049_636_463_000n)).toBe(1_793_929_049_636);
  });

  test("weights", async () => {
    // published weights (docs rate-limits page, 2026-11-05): markets 20 + floor(items / 20), bbo 2, l2OrderBook
    // 2 + floor(nLevels / 20) on the depth asked for
    expect(arcusWeight("/v1/markets", 81)).toBe(24);
    expect(arcusWeight("/v1/markets", 19)).toBe(20);
    expect(arcusWeight("/v1/bbo/BTC-USD")).toBe(2);
    expect(arcusWeight("/v1/l2OrderBook/BTC-USD", ARCUS_BOOK_LEVELS)).toBe(3);
    expect(arcusWeight("/v1/l2OrderBook/BTC-USD", 100)).toBe(7); // the documented maximum
    // Every request is recorded on the wire (what the fake venue saw, when, and the weight charged to the shared
    // governor), independent of the adapter's own bookkeeping, so a missing budget shows up here.
    const clock = fakeClock();
    const wire: { at: number; cost: number; url: string }[] = [];
    const gov = createMemoryGovernor("w", { now: clock.now, sleep: clock.sleep });
    let pending = 0;
    const rec = { ...gov, egress: gov.egress, acquire: (v: Parameters<typeof gov.acquire>[0], c: number, o?: Parameters<typeof gov.acquire>[2]) => ((pending = c), gov.acquire(v, c, o)) };
    const fetchImpl = (async (u: string) => {
      wire.push({ at: clock.now(), cost: pending, url: String(u) });
      return String(u).includes("/v1/markets") ? json(markets()) : json(fx<ArcusBook>("l2OrderBook_BTC-USD"));
    }) as unknown as typeof fetch;
    const http = venueHttp("arcus", ARCUS_MAINNET.rest, rec, { fetchImpl });
    const a = createArcusAdapter(ARCUS_MAINNET, http, null, { now: clock.now, sleep: clock.sleep });
    await a.listMarkets();
    expect(wire[0]!.cost).toBe(20 + Math.floor(100 / 20)); // assumed 100 items before the first answer
    clock.t += ARCUS_POLL_MS;
    await a.listMarkets();
    expect(wire[1]!.cost).toBe(20 + Math.floor(markets().markets.length / 20));
    const id = arcusMarketId("BTC-USD");
    await a.getBook(id);
    expect(new URL(wire[2]!.url).searchParams.get("nLevels")).toBe(String(ARCUS_BOOK_LEVELS));
    expect(wire[2]!.cost).toBe(3);
    // ten simulated minutes of the job (markets every 10 s) plus quote traffic asking for BTC books every 100 ms,
    // about 30 weight per second of demand against a 10 per second allowance
    const start = clock.t;
    const end = start + 600_000;
    let books = 0;
    while (clock.t < end) {
      await a.snapshot();
      await a.getBook(id);
      books++;
      clock.t += 100;
    }
    const sent = wire.filter((x) => x.at >= start && x.at < end);
    const CAP = 10; // research/venue-readonly.md 2.3: stay under 10 weight per second total for Arcus
    expect(ARCUS_WEIGHT_PER_S).toBe(CAP);
    // every 10 s window on the wire stays within 100 weight, and the ten-minute average within 10 per second
    for (const e of sent) {
      const win = sent.filter((x) => x.at > e.at - 10_000 && x.at <= e.at).reduce((s, x) => s + x.cost, 0);
      expect(win).toBeLessThanOrEqual(CAP * 10);
    }
    const total = sent.reduce((s, x) => s + x.cost, 0);
    expect(total / 600).toBeLessThanOrEqual(CAP);
    // the budget throttles rather than starves: the allowance is used and the markets poll keeps its 10 s cadence
    expect(total / 600).toBeGreaterThan(CAP * 0.8);
    expect(sent.filter((x) => x.url.includes("/v1/markets")).length).toBeGreaterThanOrEqual(55);
    expect(books).toBeGreaterThan(100);
    // the adapter's own log agrees with the wire for the last window it keeps
    const t = clock.now();
    expect(a.weightUsed()).toBe(wire.filter((x) => x.at > t - 10_000).reduce((s, x) => s + x.cost, 0));
  });

  test("retry-after", async () => {
    // The hint (Retry-After: 5) is larger than the governor's 2 s default, so the default wait cannot pass this test.
    // A fake governor clock records every wait: the retry is held for exactly the hinted 5000 ms.
    expect(5000).toBeGreaterThan(DEFAULT_429_MS);
    const run = async (headers: Record<string, string>) => {
      let calls = 0;
      const srv = fakeVenueServer({ "GET /v1/markets": () => (++calls === 1 ? json({ error: "rate limited" }, 429, headers) : json(markets())) });
      try {
        const clock = fakeClock();
        const waits: number[] = [];
        const gov = createMemoryGovernor("ra", { now: clock.now, sleep: async (ms) => void (waits.push(ms), await clock.sleep(ms)) });
        const a = createArcusAdapter({ ...ARCUS_MAINNET } as ArcusConfig, venueHttp("arcus", srv.url, gov, { backoffBaseMs: 1 }), memoryMarketDataCache());
        const t0 = clock.now();
        const ms = await a.listMarkets();
        expect(calls).toBe(2);
        expect(ms.length).toBe(markets().markets.length);
        return { waited: clock.now() - t0, waits };
      } finally {
        srv.stop();
      }
    };
    const hinted = await run({ "retry-after": "5" });
    expect(hinted.waits).toContain(5000);
    expect(hinted.waited).toBeGreaterThanOrEqual(5000);
    // control: with no hint the same path waits only the default, so the 5000 above came from the header
    const bare = await run({});
    expect(bare.waits).toContain(DEFAULT_429_MS);
    expect(bare.waits).not.toContain(5000);
    expect(bare.waited).toBeLessThan(5000);
  });

  test("no-kyc-fields", async () => {
    expect(ARCUS_METADATA.restrictedRegions).toEqual(["US", "CA", "GB"]);
    expect(ARCUS_METADATA.restrictedOthers).toBe(true);
    const fetchImpl = (async () => json(markets())) as unknown as typeof fetch;
    const a = createArcusAdapter(ARCUS_MAINNET, venueHttp("arcus", ARCUS_MAINNET.rest, createMemoryGovernor("k"), { fetchImpl }), null);
    const banned = /kyc|passport|identity|document|selfie|ssn|national.?id/i;
    const keysOf = (o: unknown, out: string[] = []): string[] => {
      if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) out.push(k, ...keysOf(v));
      return out;
    };
    const ms = await a.listMarkets();
    const snap = await a.snapshot();
    for (const k of [...keysOf(ms), ...keysOf(snap), ...keysOf(a.caps), ...keysOf(ARCUS_METADATA), ...Object.keys(a)]) expect(banned.test(k)).toBe(false);
    // collateral USDG, class hints from the venue category, never executable
    const m = ms.find((x) => x.venueSymbol === "NVDA-USD")!;
    expect(m).toMatchObject({ collateralAsset: "USDG", assetClassHint: "EQ", executable: false, marketType: "perp", dataFreshness: "live" });
    expect(m.sessionHours).toEqual([{ days: [1, 2, 3, 4, 5], open: "04:00", close: "20:00", tz: "America/New_York" }]);
    expect(ms.find((x) => x.venueSymbol === "BTC-USD")).toMatchObject({ assetClassHint: "CR", sessionHours: null, maxLeverage: 40, oracleSource: "pyth:1", status: "active" });
    expect(ms.some((x) => x.status === "unknown")).toBe(true); // OFFLINE markets
    // funding is hourly: ratePerHour equals the venue fundingRate
    const raw = markets().markets.find((x) => x.marketDisplayName === "BTC-USD")!;
    const f = normalizeFunding(raw, 0)!;
    expect(f.ratePerHour).toBe("0.0000125");
    expect(f.intervalS).toBe(3600);
    expect(f.capPerHour).toBe("0.04");
    expect(normalizeMarket(raw, "x").fundingSettleIntervalS).toBe(3600);
  });
});
