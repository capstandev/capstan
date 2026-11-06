// R12: a dex gone from perpDexs (catalog reduce_only) still takes reduce-only orders and close-all, never openings.
// The reader keeps the dex's last-known instruments, so the gone dex is never dropped from close-all silently.
import { describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import type { Market } from "@capstan/schema";
import { buildCloseAll, buildOrder, createHip3Gate, createHip3Hook, createHlReader, NonceSource, type HlBuildDeps, type HlMarket } from "../../src";
import { CFG, fixtureHttp, fx, USER_A } from "../helpers";
import { T0 } from "../orders/util";
import { ctx, hip3Setup, intent } from "./util";

const XYZ_POSITIONS = fx("clearinghouseState_userA_xyz").assetPositions.length;
const withoutXyz = () => fx<any[]>("perpDexs").filter((d) => d?.name !== "xyz");
/** The venue answers dex-scoped reads for a dex it no longer lists with HTTP 500 and a null body. */
const goneXyz = (b: Record<string, any>) => (b.dex === "xyz" && ["metaAndAssetCtxs", "meta", "perpDexLimits"].includes(b.type) ? null : undefined);

function depsFor(reader: ReturnType<typeof createHlReader>, cache = memoryMarketDataCache()): HlBuildDeps {
  const hip3 = createHip3Hook({ reader, gate: createHip3Gate({}), isExecutable: () => true, eqExecutionAllowed: () => true });
  return { cfg: CFG, reader, cache, nonces: new NonceSource(), enabled: () => true, hip3 };
}

describe("reduceonly", () => {
  test("gone-dex", async () => {
    // the catalog's dex status alone (old path) still refuses openings
    const h0 = hip3Setup(undefined, { dexStatus: (d) => (d === "xyz" ? "reduce_only" : "active") });
    expect((await buildOrder(intent(), ctx(), h0.deps).catch((e) => e)).code).toBe("MARKET_NOT_EXECUTABLE");

    // the real case: xyz leaves perpDexs between two meta reads, with no dexStatus hook at all
    let gone = false;
    const h = hip3Setup((b) => {
      if (!gone) return undefined;
      if (b.type === "perpDexs") return withoutXyz();
      return goneXyz(b);
    });
    const before = await h.reader.listMarkets();
    const tslaBefore = before.find((m) => m.id === "hyperliquid:xyz:TSLA")!;
    expect(tslaBefore.assetId).toBe(110001);
    gone = true;
    const after = await h.reader.listMarkets();
    expect(after.some((m) => m.dex === "xyz")).toBe(false);
    expect((await h.reader.goneDexes()).map((g) => g.dex.name)).toEqual(["xyz"]);

    const tsla = await h.reader.instrument("hyperliquid:xyz:TSLA");
    expect(tsla.status).toBe("reduce_only");
    expect(tsla.assetId).toBe(110001); // the last-known asset id, never recomputed from the shifted list

    expect((await buildOrder(intent(), ctx(), h.deps).catch((e) => e)).code).toBe("MARKET_NOT_EXECUTABLE");
    const ro = await buildOrder(intent({ side: "sell", reduceOnly: true }), ctx(), h.deps);
    expect((ro.payload.action as any).orders[0].r).toBe(true);
    expect((ro.payload.action as any).orders[0].a).toBe(110001);

    const all = await buildCloseAll({ venue: "hyperliquid", owner: USER_A }, ctx(), h.deps);
    const xyz = all.filter((b) => b.meta.marketId.startsWith("hyperliquid:xyz:"));
    expect(xyz.length).toBe(XYZ_POSITIONS);
    for (const b of xyz) {
      expect((b.payload.action as any).orders[0].r).toBe(true);
      expect(b.preview.reduceOnly).toBe(true);
      expect(b.preview.warnings.some((w) => w.includes("xyz left perpDexs"))).toBe(true);
    }
    // io stays open for new orders
    await expect(buildOrder(intent({ marketId: "hyperliquid:io:OAI", size: "0.1" }), ctx(), h.deps)).resolves.toBeDefined();
  });

  test("gone-dex-from-catalog", async () => {
    // a fresh process that never saw xyz in perpDexs: the catalog's last-known rows keep close-all whole
    const seed = await hip3Setup().reader.listMarkets();
    const rows: Market[] = seed.filter((m) => m.dex === "xyz").map(({ szDecimals: _a, pxDecimalsMax: _b, assetId: _c, dexIndex: _d, onlyIsolated: _e, ...m }: HlMarket) => ({ ...m, lotSize: `${m.lotSize}000` }));
    const http = fixtureHttp((b) => {
      if (b.type === "maxBuilderFee") return 30;
      if (b.type === "perpDexs") return withoutXyz();
      return goneXyz(b);
    });
    const reader = createHlReader(CFG, http, memoryMarketDataCache(), { now: () => T0, lastKnownDexes: async () => [{ dex: "xyz", dexIndex: 1, markets: rows }] });
    const d = depsFor(reader);
    expect((await reader.instrument("hyperliquid:xyz:TSLA")).assetId).toBe(110001);
    expect((await reader.instrument("hyperliquid:xyz:TSLA")).szDecimals).toBe(seed.find((m) => m.id === "hyperliquid:xyz:TSLA")!.szDecimals);
    expect((await reader.accountDexes()).includes("xyz")).toBe(true);
    const all = await buildCloseAll({ venue: "hyperliquid", owner: USER_A }, ctx(), d);
    expect(all.filter((b) => b.meta.marketId.startsWith("hyperliquid:xyz:")).length).toBe(XYZ_POSITIONS);
    expect(all.every((b) => (b.payload.action as any).orders?.[0]?.r !== false)).toBe(true);
  });

  test("gone-dex-unreadable", async () => {
    // the gone dex no longer answers clearinghouseState: close-all names the dex instead of returning a partial list
    let gone = false;
    const h = hip3Setup((b) => {
      if (!gone) return undefined;
      if (b.type === "perpDexs") return withoutXyz();
      if (b.type === "clearinghouseState" && b.dex === "xyz") throw new Error("hyperliquid: HTTP 500");
      return goneXyz(b);
    });
    await h.reader.listMarkets();
    gone = true;
    await h.reader.listMarkets();
    const snap = await h.reader.getAccount({ venue: "hyperliquid", owner: USER_A });
    expect(snap.unreadableDexes?.map((u) => u.dex)).toEqual(["xyz"]);
    const err = await buildCloseAll({ venue: "hyperliquid", owner: USER_A }, ctx(), h.deps).catch((e) => e);
    expect(err.code).toBe("VENUE_ERROR");
    expect(err.message).toContain("xyz");
  });
});
