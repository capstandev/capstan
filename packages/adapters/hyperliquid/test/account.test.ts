// R7, R8: master address only; one clearinghouseState per dex, never merged.
import { describe, expect, test } from "bun:test";
import { CapstanError } from "@capstan/schema";
import { fixtureReader, fx, USER_A } from "./helpers";

describe("account", () => {
  test("master-only", async () => {
    const { reader, http } = fixtureReader();
    const agents = await reader.extraAgents(USER_A);
    expect(agents.length).toBeGreaterThan(0);
    const before = http.calls.length;
    for (const a of agents) {
      const err = await reader.getAccount({ venue: "hyperliquid", owner: a.address }).catch((e) => e);
      expect(err).toBeInstanceOf(CapstanError);
      expect((err as CapstanError).code).toBe("INVALID_INPUT");
    }
    expect(http.calls.slice(before).some((c) => c.body.type === "clearinghouseState")).toBe(false);
    // a delegation-table lookup refuses an agent the reader has not seen yet
    const fresh = "0x1111111111111111111111111111111111111111" as const;
    const { reader: r2 } = fixtureReader(undefined, { isKnownAgent: (x) => x === fresh });
    expect(((await r2.getOpenOrders({ venue: "hyperliquid", owner: fresh }).catch((e) => e)) as CapstanError).code).toBe("INVALID_INPUT");
    // the venue answers an agent query with an empty account, which is why the guard exists
    expect(fx("clearinghouseState_agent").assetPositions).toEqual([]);
    // the master address works
    const snap = await reader.getAccount({ venue: "hyperliquid", owner: USER_A });
    expect(snap.identity.owner).toBe(USER_A);
  });

  test("per-dex-no-merge", async () => {
    const { reader, http } = fixtureReader();
    const snap = await reader.getAccount({ venue: "hyperliquid", owner: USER_A });
    const chs = http.calls.filter((c) => c.body.type === "clearinghouseState");
    const dexesQueried = chs.map((c) => c.body.dex ?? null);
    expect(dexesQueried[0]).toBeNull();
    // every dex with listed markets (xyz, para, mkts, io in perpDexs order)
    expect(dexesQueried).toEqual([null, "xyz", "para", "mkts", "io"]);
    for (const c of chs) {
      expect(c.body.user).toBe(USER_A);
      expect(c.cost).toBe(2);
    }
    expect(snap.perDex.map((d) => d.dex)).toEqual([null, "xyz", "para", "mkts", "io"]);
    const core = fx("clearinghouseState_userA");
    const xyz = fx("clearinghouseState_userA_xyz");
    // top-level equity is the core dex only, never a sum
    expect(snap.equityUsd).toBe(core.marginSummary.accountValue);
    expect(snap.perDex[1]!.accountValue).toBe(xyz.marginSummary.accountValue);
    expect(snap.equityUsd).not.toBe(String(Number(core.marginSummary.accountValue) + Number(xyz.marginSummary.accountValue)));
    for (const d of snap.perDex) {
      for (const p of d.positions) {
        expect(p.collateralAsset).toBe(d.collateralAsset);
        expect(p.liqPxSource).toBe("venue");
        expect(p.marketId.startsWith(`hyperliquid:${d.dex ?? "-"}:`)).toBe(true);
      }
    }
    const tsla = snap.positions.find((p) => p.marketId === "hyperliquid:xyz:TSLA")!;
    const raw = xyz.assetPositions.find((a: { position: { coin: string } }) => a.position.coin === "xyz:TSLA").position;
    expect(tsla.side).toBe("short");
    expect(tsla.size).toBe(raw.szi.slice(1));
    expect(tsla.liqPx).toBe(raw.liquidationPx);
    expect(tsla.marginMode).toBe(raw.leverage.type);
    const btc = snap.positions.find((p) => p.marketId === "hyperliquid:-:BTC")!;
    expect(btc.liqPx).toBe(core.assetPositions[0].position.liquidationPx);
    // a dex with a different collateral keeps its own label
    const { reader: r2 } = fixtureReader((b) => {
      if (b.type === "metaAndAssetCtxs" && b.dex === "flx") {
        const m = fx("metaAndAssetCtxs_flx");
        m[0].universe[0].isDelisted = false;
        return m;
      }
      if (b.type === "clearinghouseState" && b.dex === "flx") {
        const s = fx("clearinghouseState_userA_io");
        s.assetPositions[0].position.coin = "flx:COIN";
        return s;
      }
      return undefined;
    });
    const s2 = await r2.getAccount({ venue: "hyperliquid", owner: USER_A });
    const flx = s2.perDex.find((d) => d.dex === "flx")!;
    expect(flx.collateralAsset).toBe("USDH");
    expect(flx.positions[0]!.collateralAsset).toBe("USDH");
    expect(s2.equityUsd).toBe(core.marginSummary.accountValue);
  });
});
