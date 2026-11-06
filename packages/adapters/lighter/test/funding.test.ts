// R5: funding is hourly on both configs (recorded points exactly 3600 s apart) and the `rate` unit is decided by a
// golden test against the docs formula: rate is percent per hour, so ratePerHour = rate / 100.
import { afterAll, describe, expect, test } from "bun:test";
import { Dec } from "@capstan/schema";
import { FUNDING_RATE_UNIT, fundingFraction, LIGHTER_CONFIGS, type LighterDetailRaw } from "../src";
import { fakeLighter, fx, readerFor, type FxVenue } from "./helpers";

/** docs.lighter.xyz/trading/funding: fundingRate = clamp(premium + clamp(interest - premium, -small, +small), -big, +big) / 8 (all in percent). */
function docsFundingRatePct(premiumPct: number, interestPct: number, smallPct: number, bigPct: number, multiplier = 1): number {
  const premium = premiumPct * multiplier;
  const small = smallPct * multiplier;
  const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
  const smallClamped = premium + clamp(interestPct - premium, -small, small);
  return clamp(smallClamped, -bigPct, bigPct) / 8;
}

const truncate4 = (x: number) => (Math.trunc(x * 10_000) / 10_000).toFixed(4);

describe("funding", () => {
  const servers: { stop(): void }[] = [];
  afterAll(() => servers.forEach((s) => s.stop()));

  test("hourly-and-unit", async () => {
    expect(FUNDING_RATE_UNIT).toBe("percent_per_hour");
    // docs example: premium 0.1%, interest 0.01% -> 0.00625% per hour
    expect(docsFundingRatePct(0.1, 0.01, 0.05, 4)).toBeCloseTo(0.00625, 10);
    const cases: { v: FxVenue; market: number }[] = [
      { v: "lighter-304", market: 1 },
      { v: "lighter-466324", market: 11 },
    ];
    for (const { v, market } of cases) {
      const f = fx<{ resolution: string; fundings: { timestamp: number; rate: string; direction: string }[] }>(v, "fundings");
      expect(f.resolution).toBe("1h");
      expect(f.fundings.length).toBeGreaterThan(10);
      for (let i = 1; i < f.fundings.length; i++) expect(f.fundings[i]!.timestamp - f.fundings[i - 1]!.timestamp).toBe(3600);
      // golden: a quiet market sits inside the small clamp, so the rate is base_interest_rate / 8 as published (4 dp)
      const det = fx<{ order_book_details: LighterDetailRaw[] }>(v, "orderBookDetails").order_book_details.find((d) => d.market_id === market)!;
      const interest = Number(det.base_interest_rate);
      const golden = truncate4(docsFundingRatePct(interest, interest, Number(det.funding_clamp_small), Number(det.funding_clamp_big)));
      const mode = [...f.fundings.map((x) => x.rate)].sort((a, b) => f.fundings.filter((x) => x.rate === b).length - f.fundings.filter((x) => x.rate === a).length)[0];
      expect(mode).toBe(golden);
      // so the unit is percent per hour: 0.0012 -> 0.000012 per hour
      expect(fundingFraction("0.0012")).toBe("0.000012");
      expect(fundingFraction("0.0012", "short")).toBe("-0.000012");

      const cfg = v === "lighter-304" ? LIGHTER_CONFIGS.mainnet : LIGHTER_CONFIGS.rh;
      const srv = fakeLighter(v);
      servers.push(srv);
      const reader = readerFor(cfg, srv.url);
      const ms = await reader.listMarkets();
      const id = ms.find((m) => m.venueIndex === market)!.id;
      const snap = await reader.getFunding(id);
      expect(snap.intervalS).toBe(3600);
      expect(snap.source).toBe("venue");
      const last = f.fundings[f.fundings.length - 1]!;
      expect(snap.ratePerInterval).toBe(last.rate);
      expect(Dec.eq(Dec.parse(snap.ratePerHour, 12), Dec.div(Dec.parse(last.rate, 12), Dec.parse("100", 0), 12))).toBe(true);
      // funding_clamp_big 4% per 8 hours = 0.5% per hour
      expect(snap.capPerHour).toBe("0.005");
      expect(new Date(snap.nextSettlementAt).getTime() % 3_600_000).toBe(0);
    }
  });
});
