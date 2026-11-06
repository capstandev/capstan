// R12 end to end on Postgres: catalog sync marks the vanished dex gone, the api's lastKnownHlDexes reads it back, and a
// fresh reader still builds reduce-only closes for every position on it.
import { afterAll, describe, expect, test } from "bun:test";
import { syncMarkets } from "@capstan/catalog";
import { closeDb, createDb, createTempDatabase, memoryMarketDataCache, TEST_DATABASE_URL } from "@capstan/core";
import { createMemoryGovernor } from "@capstan/venue-client";
import { lastKnownHlDexes } from "../../../../../apps/api/src/adapters";
import { hyperliquidSource } from "../../../../../apps/workers/src/jobs/catalog-sources/hyperliquid.source";
import { buildCloseAll, createHip3Gate, createHip3Hook, createHlReader, NonceSource } from "../../src";
import { CFG, fixtureHttp, fx, USER_A } from "../helpers";
import { ctx, T0 } from "../orders/util";

const dbTest = TEST_DATABASE_URL ? test : test.skip;

describe("reduceonly", () => {
  let drop: (() => Promise<void>) | null = null;
  afterAll(async () => {
    await drop?.();
  });

  dbTest("gone-dex-catalog-db", async () => {
    const tmp = await createTempDatabase(TEST_DATABASE_URL!, { migrated: true, prefix: "capstan_hlgone" });
    drop = tmp.drop;
    const db = createDb(tmp.url, { max: 2 });
    try {
      let gone = false;
      const answer = (b: Record<string, any>) => {
        if (b.type === "maxBuilderFee") return 30;
        if (!gone) return undefined;
        if (b.type === "perpDexs") return fx<any[]>("perpDexs").filter((d) => d?.name !== "xyz");
        if (b.dex === "xyz" && ["metaAndAssetCtxs", "meta", "perpDexLimits"].includes(b.type)) return null;
        return undefined;
      };
      const rt = (http = fixtureHttp(answer)) => ({ cfg: CFG, governor: createMemoryGovernor("t"), http, reader: createHlReader(CFG, http, memoryMarketDataCache()) });
      await syncMarkets(db, [hyperliquidSource(rt())], new Date("2026-11-06T00:00:00Z"));
      gone = true;
      const r2 = await syncMarkets(db, [hyperliquidSource(rt())], new Date("2026-11-06T00:10:00Z"));
      expect(r2.reduceOnly.some((id) => id.startsWith("hyperliquid:xyz:"))).toBe(true);

      const known = await lastKnownHlDexes(db);
      expect(known.map((k) => [k.dex, k.dexIndex])).toEqual([["xyz", 1]]);

      const reader = createHlReader(CFG, fixtureHttp(answer), memoryMarketDataCache(), { now: () => T0, lastKnownDexes: () => lastKnownHlDexes(db) });
      expect((await reader.instrument("hyperliquid:xyz:TSLA")).assetId).toBe(110001);
      const hip3 = createHip3Hook({ reader, gate: createHip3Gate({}), isExecutable: () => false });
      const all = await buildCloseAll({ venue: "hyperliquid", owner: USER_A }, ctx(), { cfg: CFG, reader, cache: memoryMarketDataCache(), nonces: new NonceSource(), enabled: () => true, hip3 });
      const xyz = all.filter((b) => b.meta.marketId.startsWith("hyperliquid:xyz:"));
      expect(xyz.length).toBe(fx("clearinghouseState_userA_xyz").assetPositions.length);
      for (const b of xyz) expect((b.payload.action as any).orders[0].r).toBe(true);
    } finally {
      await closeDb(db);
    }
  }, 60_000);
});
