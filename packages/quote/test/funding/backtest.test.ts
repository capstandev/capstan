// R4 (todo 18): back-test on 30 days of recorded settled funding reports MAE for the forecast and for naive carry,
// written to test/funding/backtest-report.json. Both numbers must exist and be finite; the forecast need not win.
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { backtest, backtestSeries } from "../../src/funding/backtest";
import { fundingFixtures } from "./helpers";

const PG = process.env.DATABASE_URL;

describe("backtest", () => {
  test("pure series on the fixtures", () => {
    for (const f of fundingFixtures()) {
      const r = backtestSeries(f.marketId, f.rows.map((x) => ({ ts: Date.parse(x.ts), ratePerHour: x.ratePerHour })));
      expect(r.n).toBeGreaterThan(50);
      expect(Number.isFinite(r.maeForecast)).toBe(true);
      expect(Number.isFinite(r.maeNaiveCarry)).toBe(true);
    }
    // a constant series has zero error for both
    const flat = backtestSeries("x", Array.from({ length: 50 }, (_, i) => ({ ts: i * 3600_000, ratePerHour: "0.0000125" })));
    expect(flat).toEqual({ marketId: "x", maeForecast: 0, maeNaiveCarry: 0, n: 26 });
  });
});

(PG ? describe : describe.skip)("backtest with a database", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterAll(async () => {
    await cleanup?.();
  }, 30_000);
  test(
    "mae-reported",
    async () => {
      const { createTempDatabase, createDb, closeDb } = await import("@capstan/core");
      const { db: schema } = await import("@capstan/schema");
      const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_bt" });
      const db = createDb(t.url, { max: 2 });
      cleanup = async () => {
        await closeDb(db);
        await t.drop();
      };
      const fx = fundingFixtures();
      expect(fx.length).toBeGreaterThanOrEqual(7);
      for (const f of fx) {
        const rows = f.rows.map((r) => ({ ts: new Date(r.ts), marketId: f.marketId, ratePerInterval: r.ratePerHour, intervalS: 3600, ratePerHour: r.ratePerHour, predictedNext: null, source: "venue" }));
        for (let i = 0; i < rows.length; i += 500) await db.insert(schema.fundingTicks).values(rows.slice(i, i + 500)).onConflictDoNothing();
      }
      const from = new Date(Math.min(...fx.map((f) => Date.parse(f.from))));
      const to = new Date(Math.max(...fx.map((f) => Date.parse(f.to))));
      const report = await backtest(db, fx.map((f) => f.marketId), from, to);
      expect(report.length).toBe(fx.length);
      for (const r of report) {
        expect(r.n).toBeGreaterThan(50);
        expect(Number.isFinite(r.maeForecast)).toBe(true);
        expect(Number.isFinite(r.maeNaiveCarry)).toBe(true);
        expect(r.maeForecast).toBeGreaterThanOrEqual(0);
      }
      const body = {
        note: "Back-test of the EWMA funding forecast (half-life 8 h, 7-day lookback, 24-row warm-up) against naive carry (last rate held). MAE in bps per hour on settled rates. Observed data; it says nothing about future funding.",
        window: { from: from.toISOString(), to: to.toISOString() },
        fixtures: fx.map((f) => ({ name: f.name, marketId: f.marketId, rows: f.rows.length })),
        results: report,
      };
      writeFileSync(join(import.meta.dir, "backtest-report.json"), JSON.stringify(body, null, 1) + "\n");
    },
    30_000,
  );
});
