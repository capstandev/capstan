// R2 data-only legs never executable, R3 cadence-aware per-hour comparison with both venues' next settlements,
// R6 different collateral carries the depeg flag and is never converted, R8 each leg shows its own liquidation price.
import { describe, expect, test } from "bun:test";
import { executableLeg, scan, untoleratedDiffs } from "../../src";
import { funding, M, market, NOW, REQ, setup } from "./helpers";

describe("scan", () => {
  test("no-data-only-legs", async () => {
    const s = setup();
    const rows = await scan(REQ, s.deps);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect([r.legA.venue, r.legB.venue]).not.toContain("variational");
      expect([r.legA.venue, r.legB.venue]).not.toContain("arcus");
      // Variational's big rate shows only as a reference column
      expect(r.references).toEqual([{ marketId: M.var.id, venue: "variational", ratePerHour: "0.004", dataFreshness: "delayed" }]);
    }
    // with only one executable leg plus a data-only market: no row at all
    const one = setup({ markets: [M.hl, M.var], eqs: [{ id: "e", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.var.id], status: "approved", notes: "" }] });
    expect(await scan(REQ, one.deps)).toEqual([]);
    // the venue rule holds on its own: a Variational or Arcus row wrongly marked executable, active and live, behind an
    // adapter that wrongly claims execution, with the largest funding gap, is still never a leg and shows only as a
    // reference column (no other filter can catch it here, so this fails if the DATA_ONLY venue check is removed)
    // collateral USDT with no override note: if Variational were a leg, the HL pair would raise a blocking-diff alert
    const varExec = market("variational:-:ETH", "variational", { executable: true, dataFreshness: "live", collateralAsset: "USDT" });
    const arcExec = market("arcus:-:ETH", "arcus", { executable: true, dataFreshness: "live" });
    expect(executableLeg(varExec)).toBe(false);
    expect(executableLeg(arcExec)).toBe(false);
    expect(executableLeg(M.hl)).toBe(true);
    const claimExecution = (x: ReturnType<typeof setup>) => {
      const hl = x.deps.quote.adapters.get("hyperliquid")!;
      for (const v of ["variational", "arcus"] as const) x.deps.quote.adapters.set(v, { ...hl, caps: { ...hl.caps, venue: v } });
      return x;
    };
    const mis = claimExecution(setup({
      markets: [M.hl, varExec, arcExec],
      eqs: [{ id: "e", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, varExec.id, arcExec.id], status: "approved", notes: "" }],
      fund: [
        [M.hl.id, funding(M.hl.id, "0.0001", 3600)],
        [varExec.id, funding(varExec.id, "-0.004", 3600)],
        [arcExec.id, funding(arcExec.id, "0.006", 3600)],
      ],
    }));
    expect(await scan(REQ, mis.deps)).toEqual([]);
    expect(mis.alerts).toEqual([]);
    const withLt = claimExecution(setup({
      markets: [M.hl, M.lt, varExec, arcExec],
      eqs: [{ id: "e", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.lt.id, varExec.id, arcExec.id], status: "approved", notes: "" }],
      fund: [
        [M.hl.id, funding(M.hl.id, "0.0001", 3600)],
        [M.lt.id, funding(M.lt.id, "0.00002", 3600)],
        [varExec.id, funding(varExec.id, "-0.004", 3600)],
        [arcExec.id, funding(arcExec.id, "0.006", 3600)],
      ],
    }));
    const misRows = await scan(REQ, withLt.deps);
    expect(misRows.length).toBeGreaterThan(0);
    for (const r of misRows) {
      expect([r.legA.venue, r.legB.venue].sort()).toEqual(["hyperliquid", "lighter-mainnet"]);
      expect(r.references.map((x) => x.venue).sort()).toEqual(["arcus", "variational"]);
    }
    expect(withLt.alerts).toEqual([]);
  });

  test("cadences", async () => {
    // HL 1 h at 0.0001 per hour (1.0 bp/h) against Aster 8 h at 0.0004 per 8 h (0.5 bp/h): per-hour rates compared
    const s = setup({ markets: [M.hl, M.aster], eqs: [{ id: "e", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.aster.id], status: "approved", notes: "r\noverride: USDT leg reviewed" }] });
    const [r] = await scan(REQ, s.deps);
    expect(r).toBeDefined();
    const short = r!.legA.side === "sell" ? r!.legA : r!.legB;
    const long = r!.legA.side === "buy" ? r!.legA : r!.legB;
    expect(short.marketId).toBe(M.hl.id); // the higher-funding leg is the short
    expect(long.marketId).toBe(M.aster.id);
    expect(short.ratePerHour).toBe("0.0001");
    expect(long.ratePerHour).toBe("0.00005");
    expect(r!.fundingDiffPerHourBps).toBe(0.5);
    // both venues' next settlements: HL in 30 minutes, Aster in 4 hours
    expect(r!.nextSettlements).toEqual([
      { venue: "hyperliquid", at: new Date(NOW.getTime() + 30 * 60_000).toISOString() },
      { venue: "aster", at: new Date(NOW.getTime() + 4 * 3600_000).toISOString() },
    ]);
    // flip the rates: the short moves to the other leg
    s.fund.set(M.aster.id, funding(M.aster.id, "0.0016", 28800, new Date(NOW.getTime() + 4 * 3600_000).toISOString())); // 2 bp/h
    const [r2] = await scan(REQ, s.deps);
    expect((r2!.legA.side === "sell" ? r2!.legA : r2!.legB).marketId).toBe(M.aster.id);
    expect(r2!.fundingDiffPerHourBps).toBe(1);
  });

  test("depeg-flag", async () => {
    // Lighter-RH (USDG) against HL (USDC): flagged, each leg keeps its own collateral, nothing converted
    const s = setup({ markets: [M.hl, M.rh], eqs: [{ id: "e", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.rh.id], status: "approved", notes: "reviewed\noverride: USDG leg reviewed" }], usdgBps: 40 });
    const [r] = await scan(REQ, s.deps);
    expect(r!.flags).toContain("DEPEG_FLAG");
    expect([r!.legA.collateralAsset, r!.legB.collateralAsset].sort()).toEqual(["USDC", "USDG"]);
    // an unknown USDG reading is flagged too
    const u = setup({ markets: [M.hl, M.rh], eqs: [{ id: "e", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.rh.id], status: "approved", notes: "r\noverride: x" }], usdgBps: null });
    expect((await scan(REQ, u.deps))[0]!.flags).toContain("DEPEG_UNKNOWN");
    // same collateral: no flag
    const same = setup({ markets: [M.hl, M.lt], eqs: [{ id: "e", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.lt.id], status: "approved", notes: "" }] });
    expect((await scan(REQ, same.deps))[0]!.flags).toEqual([]);
    // a collateral difference that was never overridden at approval (a market changed since) drops the row and alerts
    const changed = setup({ markets: [M.hl, M.rh], eqs: [{ id: "e2", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.rh.id], status: "approved", notes: "reviewed" }] });
    expect(await scan(REQ, changed.deps)).toEqual([]);
    expect(changed.alerts).toEqual([{ equivalenceId: "e2", a: M.hl.id, b: M.rh.id, fields: ["collateralAsset"] }]);
    // any other blocking change (contract multiplier) is never tolerated, override or not
    expect(untoleratedDiffs(M.hl, { ...M.lt, contractMultiplier: "10" }, "x\noverride: y")).toEqual(["contractMultiplier"]);
  });

  test("two-liq-prices", async () => {
    const s = setup({ markets: [M.hl, M.lt], eqs: [{ id: "e", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.lt.id], status: "approved", notes: "" }] });
    const [r] = await scan({ ...REQ, leverage: 5 }, s.deps);
    const short = r!.legA.side === "sell" ? r!.legA : r!.legB;
    const long = r!.legA.side === "buy" ? r!.legA : r!.legB;
    // each leg: its own venue's estimate at 5x; the short's is above the price, the long's below
    expect(Number(short.estLiqPx)).toBeGreaterThan(2000);
    expect(Number(long.estLiqPx)).toBeLessThan(2000);
    expect(short.venue).not.toBe(long.venue);
    const higher = await scan({ ...REQ, leverage: 10 }, s.deps);
    const longAt10 = higher[0]!.legA.side === "buy" ? higher[0]!.legA : higher[0]!.legB;
    expect(Number(longAt10.estLiqPx)).toBeGreaterThan(Number(long.estLiqPx)); // closer at higher leverage
    // nothing in the row nets margin or collateral: no such key anywhere
    const keys = JSON.stringify(r).match(/"([A-Za-z]+)":/g)!.map((k) => k.slice(1, -2));
    for (const k of keys) expect(k).not.toMatch(/margin|netted|shared|total(Equity|Collateral)/i);
    // leg A is the less liquid leg (the Lighter book is thinner in the fixture)
    expect(r!.legA.venue).toBe("lighter-mainnet");
    expect(Number(r!.legA.depthUsdAt10bps)).toBeLessThan(Number(r!.legB.depthUsdAt10bps));
  });
});
