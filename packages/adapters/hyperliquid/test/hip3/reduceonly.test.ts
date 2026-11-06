// R12: a dex gone from perpDexs (catalog reduce_only) still takes reduce-only orders and close-all, never openings.
import { describe, expect, test } from "bun:test";
import { buildCloseAll, buildOrder } from "../../src";
import { USER_A } from "../helpers";
import { ctx, hip3Setup, intent } from "./util";

describe("reduceonly", () => {
  test("gone-dex", async () => {
    const h = hip3Setup(undefined, { dexStatus: (d) => (d === "xyz" ? "reduce_only" : "active") });
    expect((await buildOrder(intent(), ctx(), h.deps).catch((e) => e)).code).toBe("MARKET_NOT_EXECUTABLE");
    const ro = await buildOrder(intent({ side: "sell", reduceOnly: true }), ctx(), h.deps);
    expect((ro.payload.action as any).orders[0].r).toBe(true);
    const all = await buildCloseAll({ venue: "hyperliquid", owner: USER_A }, ctx(), h.deps);
    const xyz = all.filter((b) => b.meta.marketId.startsWith("hyperliquid:xyz:"));
    expect(xyz.length).toBeGreaterThan(0);
    for (const b of xyz) expect((b.payload.action as any).orders[0].r).toBe(true);
    // io stays open for new orders
    await expect(buildOrder(intent({ marketId: "hyperliquid:io:OAI", size: "0.1" }), ctx(), h.deps)).resolves.toBeDefined();
  });
});
