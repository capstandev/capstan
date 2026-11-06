import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Db } from "@capstan/core";
import { db as schema } from "@capstan/schema";
import { eq } from "drizzle-orm";
import { approvedEquivalences, contractSpecDiff, isExecutable, proposeEquivalence, reviewEquivalence, rowToMarket, setDexExecutable } from "../src/review";
import { syncMarkets } from "../src/sync";
import { dbDescribe, freshDb } from "./db-helper";
import { asterSource, hyperliquidSource, lighterSource, staticSource } from "./fixture-sources";

let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: Db;
const T = new Date("2026-11-06T00:15:00Z");
const NYSE = [{ days: [1, 2, 3, 4, 5], open: "09:30", close: "16:00", tz: "America/New_York" }];

async function row(id: string) {
  const [r] = await db.select().from(schema.markets).where(eq(schema.markets.id, id));
  return r!;
}

dbDescribe("review", () => {
  beforeAll(async () => {
    ctx = await freshDb();
    db = ctx.db;
    await syncMarkets(db, [hyperliquidSource(), lighterSource("lighter-304"), asterSource()], T);
    await syncMarkets(db, [staticSource("arcus", [{ venueSymbol: "TSLA-USD", collateralAsset: "USDC", sessionHours: NYSE, assetClassHint: "EQ" }, { venueSymbol: "AAPL-USD", contractMultiplier: "10", assetClassHint: "EQ" }])], T);
  });
  afterAll(async () => {
    await ctx.drop();
  });

  test("blocking-diff", async () => {
    // different collateral: Hyperliquid xyz (USDC) vs Aster TSLAUSDT (USDT)
    const xyz = await row("hyperliquid:xyz:TSLA");
    const ast = await row("aster:-:TSLAUSDT");
    expect(contractSpecDiff(rowToMarket(xyz), rowToMarket(ast)).find((d) => d.field === "collateralAsset")).toMatchObject({ blocking: true, a: "USDC", b: "USDT" });
    const e1 = await proposeEquivalence(db, "EQ:TSLA", [xyz.id, ast.id], "same TSLA?");
    await expect(reviewEquivalence(db, e1, "approved", "rev", "looks same")).rejects.toThrow("blocking contract differences");
    expect((await db.select().from(schema.equivalences).where(eq(schema.equivalences.id, e1)))[0]!.status).toBe("proposed");
    // session-limited vs 24/7 and a different multiplier also block
    const tslaArcus = rowToMarket(await row("arcus:-:TSLA-USD"));
    expect(contractSpecDiff(rowToMarket(xyz), tslaArcus).find((d) => d.field === "sessionHours")).toMatchObject({ blocking: true, a: "24/7" });
    const aapl = rowToMarket(await row("arcus:-:AAPL-USD"));
    expect(contractSpecDiff(rowToMarket(await row("aster:-:AAPLUSDT")), aapl).find((d) => d.field === "contractMultiplier")).toMatchObject({ blocking: true, a: "1", b: "10" });
    // tick size alone does not block
    expect(contractSpecDiff(rowToMarket(xyz), { ...rowToMarket(xyz), tickSize: "0.5" })).toEqual([{ field: "tickSize", a: xyz.tickSize, b: "0.5", blocking: false }]);
    // with an override reason the approval goes through and the reason is stored
    const r = await reviewEquivalence(db, e1, "approved", "rev", "same underlying, legs keep their own collateral", { overrideReason: "collateral differs by design" });
    expect(r.status).toBe("approved");
    const [stored] = await db.select().from(schema.equivalences).where(eq(schema.equivalences.id, e1));
    expect(stored!.notes).toContain("override: collateral differs by design");
    // equities stay non-executable without the legal flag, even after approval
    expect(r.executable).toEqual([]);
    expect(r.notExecutable.map((x) => x.why).join(" ")).toContain("EQ_EXECUTION_ALLOWED");
    expect((await row(ast.id)).executable).toBe(false);
    expect((await row(xyz.id)).canonicalAsset).toBe("EQ:TSLA");
    // a review needs a reviewer and notes; a decided record cannot be reviewed again
    await expect(reviewEquivalence(db, e1, "approved", "rev", "again")).rejects.toThrow("already approved");
    const e2 = await proposeEquivalence(db, "EQ:AAPL", ["aster:-:AAPLUSDT", "arcus:-:AAPL-USD"], "aapl");
    await expect(reviewEquivalence(db, e2, "approved", "", "n")).rejects.toThrow("reviewer");
  });

  test("approved-only", async () => {
    const btc = await proposeEquivalence(db, "CR:BTC", ["hyperliquid:-:BTC", "lighter-mainnet:-:BTC"], "majors");
    const eth = await proposeEquivalence(db, "CR:ETH", ["hyperliquid:-:ETH", "lighter-mainnet:-:ETH"], "majors");
    const sol = await proposeEquivalence(db, "CR:SOL", ["hyperliquid:-:SOL", "lighter-mainnet:-:SOL"], "majors");
    expect((await approvedEquivalences(db)).map((e) => e.id)).not.toContain(btc);
    const r = await reviewEquivalence(db, btc, "approved", "rev", "same BTC");
    expect(r.executable.sort()).toEqual(["hyperliquid:-:BTC", "lighter-mainnet:-:BTC"]);
    expect(await isExecutable(db, "hyperliquid:-:BTC")).toEqual({ ok: true });
    await reviewEquivalence(db, eth, "rejected", "rev", "not now");
    const approved = await approvedEquivalences(db);
    expect(approved.every((e) => e.status === "approved")).toBe(true);
    expect(approved.map((e) => e.id)).toContain(btc);
    expect(approved.map((e) => e.id)).not.toContain(eth);
    expect(approved.map((e) => e.id)).not.toContain(sol);
    expect((await approvedEquivalences(db, "CR:BTC")).map((e) => e.id)).toEqual([btc]);
    expect(await approvedEquivalences(db, "CR:ETH")).toEqual([]);
    // a dex market needs its dex reviewed first, then the market itself
    const ethXyz = await proposeEquivalence(db, "CR:XYZ100", ["hyperliquid:xyz:XYZ100", "hyperliquid:xyz:XYZ100"].slice(0, 1).concat(["aster:-:BTCUSDT"]), "bad pair on purpose");
    await expect(reviewEquivalence(db, ethXyz, "approved", "rev", "x")).rejects.toThrow("blocking contract differences");
    await expect(reviewEquivalence(db, ethXyz, "approved", "rev", "x", { overrideReason: "test" })).rejects.toThrow("already mapped to CR:BTC");
    await setDexExecutable(db, "hyperliquid", "xyz", true, "rev", "xyz reviewed");
    const reviews = await db.select().from(schema.catalogReviews);
    expect(reviews.some((x) => x.subject === "dex:hyperliquid:xyz" && x.reviewer === "rev")).toBe(true);
    expect(reviews.some((x) => x.subject === `equivalence:${btc}`)).toBe(true);
  });
});
