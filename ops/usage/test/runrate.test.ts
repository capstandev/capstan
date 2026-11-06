import { describe, expect, test } from "bun:test";
import { runRate } from "../usage";
import { usageDay } from "./helpers";

describe("run-rate", () => {
  test("formula: last 7 full days x 30 / 7 per venue and total; Lighter counts as routed at 0 fee", () => {
    const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"].map((d, i) =>
      usageDay(d, { notional: { hl: String(100_000 * (i + 1)), aster: "7000", lighter304: "700", lighterRh: "70.07" }, builderFeeUsd: { hl: "1", aster: "1" } }),
    );
    const r = runRate(days, "2026-11-08"); // days 2..8: hl = 100k x (2+...+8) = 3,500,000
    expect(r.daysFound).toBe(7);
    expect(r.perVenue.hl).toBe("15000000.000000"); // 3,500,000 x 30 / 7
    expect(r.perVenue.aster).toBe("210000.000000"); // 49,000 x 30 / 7
    expect(r.perVenue.lighter304).toBe("21000.000000");
    expect(r.perVenue.lighterRh).toBe("2102.100000"); // 490.49 x 30 / 7
    expect(r.total).toBe("15233102.100000");
    // a non-terminating division rounds down at 6 places
    const odd = runRate([usageDay("2026-11-08", { notional: { hl: "1" } })], "2026-11-08");
    expect(odd.perVenue.hl).toBe("4.285714");
    expect(odd.daysFound).toBe(1);
    // fuzz: total equals the per-venue sum within the rounding of 4 divisions
    for (let k = 0; k < 500; k++) {
      const ds = Array.from({ length: 7 }, (_, i) => usageDay(`2026-11-0${i + 1}`, { notional: { hl: (Math.random() * 1e7).toFixed(6), aster: (Math.random() * 1e6).toFixed(2), lighter304: String(Math.floor(Math.random() * 1e5)), lighterRh: "0" } }));
      const x = runRate(ds, "2026-11-07");
      const sum = Object.values(x.perVenue).reduce((a, v) => a + Math.round(Number(v) * 1e6), 0);
      expect(Math.abs(Math.round(Number(x.total) * 1e6) - sum)).toBeLessThanOrEqual(4);
    }
  });
});
