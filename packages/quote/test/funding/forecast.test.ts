// R2, R3, R5 (todo 18): forecast method per venue, settlement times per cadence, the published cap.
import { describe, expect, test } from "bun:test";
import type { Market, VenueId } from "@capstan/schema";
import { capFor, ewmaRate, forecast, nextSettlements, type FundingTick } from "../../src/funding/forecast";

const NOW = new Date("2026-11-06T10:20:00Z");
const mk = (id: string, venue: VenueId, settleS: number, o: Partial<Market> = {}) => ({ id, venue, dex: id.split(":")[1] === "-" ? null : id.split(":")[1]!, fundingSettleIntervalS: settleS, dataFreshness: (venue === "variational" ? "delayed" : "live") as Market["dataFreshness"], ...o });
const hist = (id: string, rates: string[]): FundingTick[] => rates.map((r, i) => ({ ts: new Date(NOW.getTime() - (rates.length - i) * 3600_000), marketId: id, ratePerHour: r }));

describe("forecast", () => {
  test("method-per-venue", () => {
    const h = (id: string) => hist(id, ["0.00001", "0.00002", "0.00003"]);
    const hl = forecast(mk("hyperliquid:-:BTC", "hyperliquid", 3600), h("hyperliquid:-:BTC"), "0.0000125", NOW);
    expect(hl.settlements[0]!.method).toBe("venue");
    expect(hl.settlements[0]!.predictedRatePerHour).toBe("0.0000125");
    expect(hl.settlements.length).toBe(8);
    for (const [id, venue, s] of [
      ["hyperliquid:xyz:TSLA", "hyperliquid", 3600],
      ["aster:-:BTCUSDT", "aster", 28_800],
      ["lighter-mainnet:-:BTC", "lighter-mainnet", 3600],
      ["lighter-rh:-:AMZN", "lighter-rh", 3600],
      ["arcus:-:BTC-USD", "arcus", 3600],
    ] as const) {
      // even when a venue prediction is passed, these venues use the EWMA of the observed rate history, and the
      // method says so ('ewma_rate': funding_ticks holds rates, not premiums; BACKLOG C31)
      const f = forecast(mk(id, venue, s), h(id), "0.5", NOW);
      expect(f.settlements.every((x) => x.method === "ewma_rate")).toBe(true);
      expect(f.settlements[0]!.predictedRatePerHour).toBe(ewmaRate(h(id).map((x) => ({ ts: (x.ts as Date).getTime(), rate: x.ratePerHour }))));
    }
    // Variational: its next.interval_rate (normalised per hour by the caller) as 'venue', flagged delayed
    const v = forecast(mk("variational:-:BTC-PERP", "variational", 14_400), h("variational:-:BTC-PERP"), "0.0000125", NOW);
    expect(v.settlements.every((x) => x.method === "venue" && x.predictedRatePerHour === "0.0000125")).toBe(true);
    expect(v.dataFreshness).toBe("delayed");
    // HL core without a prediction falls back to the EWMA; nothing at all gives no settlements
    expect(forecast(mk("hyperliquid:-:ETH", "hyperliquid", 3600), h("hyperliquid:-:ETH"), null, NOW).settlements[0]!.method).toBe("ewma_rate");
    expect(forecast(mk("aster:-:X", "aster", 3600), [], null, NOW).settlements).toEqual([]);
    expect(forecast(mk("aster:-:X", "aster", 3600), [], "0.0001", NOW).settlements[0]!.method).toBe("last");
    // EWMA: equal weights at equal age, newer points weigh more; half-life 8 h halves the weight of an 8 h old point
    expect(ewmaRate([{ ts: 0, rate: "0.0001" }])).toBe("0.0001");
    expect(Number(ewmaRate([{ ts: 0, rate: "0" }, { ts: 8 * 3600_000, rate: "0.0003" }]))).toBeCloseTo(0.0002, 12);
  });

  test("settlement-times", () => {
    // HL, Lighter, Arcus: every hour on the hour
    for (const v of ["hyperliquid", "lighter-mainnet", "arcus"] as const) {
      const t = nextSettlements({ fundingSettleIntervalS: 3600 }, NOW, 8);
      expect(t[0]).toBe("2026-11-06T11:00:00.000Z");
      expect(t[7]).toBe("2026-11-06T18:00:00.000Z");
      void v;
    }
    // Aster at its market interval from nextFundingTime (a 4 h market that next pays at 12:00)
    const a = nextSettlements({ fundingSettleIntervalS: 14_400 }, NOW, 8, "2026-11-06T12:00:00.000Z");
    expect(a.slice(0, 3)).toEqual(["2026-11-06T12:00:00.000Z", "2026-11-06T16:00:00.000Z", "2026-11-06T20:00:00.000Z"]);
    expect(a.length).toBe(8);
    // Variational per interval_seconds (8 h), anchored on next_timestamp
    const v = nextSettlements({ fundingSettleIntervalS: 28_800 }, NOW, 8, "2026-11-06T16:00:00.000Z");
    expect(v[1]).toBe("2026-11-07T00:00:00.000Z");
    // a venue time already past is ignored: the cadence grid takes over (never a settlement in the past)
    const p = nextSettlements({ fundingSettleIntervalS: 28_800 }, NOW, 2, "2026-11-06T08:00:00.000Z");
    expect(p).toEqual(["2026-11-06T16:00:00.000Z", "2026-11-07T00:00:00.000Z"]);
    // the forecast uses the same times
    const f = forecast(mk("aster:-:BTCUSDT", "aster", 14_400), hist("aster:-:BTCUSDT", ["0.00001"]), null, NOW, { venueNext: "2026-11-06T12:00:00.000Z" });
    expect(f.settlements.map((s) => s.at)).toEqual(a);
  });

  test("clamp", () => {
    // HL caps funding at 4% per hour: a forecast above it is clamped, both signs
    const hi = forecast(mk("hyperliquid:-:BTC", "hyperliquid", 3600), [], "0.09", NOW);
    expect(hi.settlements.every((s) => s.predictedRatePerHour === "0.04")).toBe(true);
    const lo = forecast(mk("hyperliquid:xyz:TSLA", "hyperliquid", 3600), hist("hyperliquid:xyz:TSLA", ["-0.07", "-0.08"]), null, NOW);
    expect(lo.settlements.every((s) => s.predictedRatePerHour === "-0.04")).toBe(true);
    // Arcus publishes the same 4% cap; Lighter publishes none, so nothing is clamped there
    expect(forecast(mk("arcus:-:BTC-USD", "arcus", 3600), hist("arcus:-:BTC-USD", ["0.05"]), null, NOW).settlements[0]!.predictedRatePerHour).toBe("0.04");
    expect(forecast(mk("lighter-mainnet:-:BTC", "lighter-mainnet", 3600), hist("lighter-mainnet:-:BTC", ["0.05"]), null, NOW).settlements[0]!.predictedRatePerHour).toBe("0.05");
    // a snapshot's own cap overrides the table
    expect(forecast(mk("aster:-:X", "aster", 3600), hist("aster:-:X", ["0.05"]), null, NOW, { capPerHour: "0.02" }).settlements[0]!.predictedRatePerHour).toBe("0.02");
    // a snapshot that states no cap (null: a HIP-3 market without fundingClamp) still gets the venue cap
    expect(capFor({ venue: "hyperliquid" }, null)).toBe("0.04");
    expect(capFor({ venue: "lighter-mainnet" }, null)).toBeNull();
    expect(forecast(mk("hyperliquid:xyz:TSLA", "hyperliquid", 3600), hist("hyperliquid:xyz:TSLA", ["0.09"]), null, NOW, { capPerHour: null }).settlements[0]!.predictedRatePerHour).toBe("0.04");
  });
});
