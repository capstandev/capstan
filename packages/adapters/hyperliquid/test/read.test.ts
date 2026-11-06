// R1, R3, R4, R9, R10: markets from meta, collateral per dex, margin modes, builder fee unit, unknown info types.
import { describe, expect, test } from "bun:test";
import { createMemoryGovernor, errorResponse, fakeVenueServer, venueHttp } from "@capstan/venue-client";
import { memoryMarketDataCache } from "@capstan/core";
import { CapstanError } from "@capstan/schema";
import { createHlReader, HlUnknownInfoType, marginModesOf } from "../src";
import { CFG, fixtureReader, fx, USER_A } from "./helpers";

describe("read", () => {
  test("core-meta", async () => {
    const { reader } = fixtureReader();
    const all = await reader.listMarkets();
    const core = all.filter((m) => m.dex === null);
    expect(core.length).toBe(235);
    expect(core.filter((m) => m.status === "delisted").length).toBe(56);
    const btc = core[0]!;
    expect(btc.venueSymbol).toBe("BTC");
    expect(btc.id).toBe("hyperliquid:-:BTC");
    expect(btc.venueIndex).toBe(0);
    expect(btc.assetId).toBe(0);
    expect(btc.lotSize).toBe("0.00001");
    expect(btc.pxDecimalsMax).toBe(1);
    expect(btc.tickSize).toBe("1"); // 5 significant figures at a ~76,000 mark
    expect(btc.maxLeverage).toBe(40);
    expect(btc.fundingIntervalS).toBe(28800);
    expect(btc.fundingSettleIntervalS).toBe(3600);
    expect(btc.builderFeeUnit).toBe("tenths_bp");
    expect(btc.sessionHours).toBeNull();
    expect(btc.oiCapUsd).toBeNull();
    expect(all.every((m) => m.executable === false)).toBe(true);
    // delisted entries keep their raw index
    const matic = core.find((m) => m.venueSymbol === "MATIC")!;
    expect(matic.status).toBe("delisted");
    expect(matic.venueIndex).toBe(3);
  });

  test("collateral-per-dex", async () => {
    const { reader } = fixtureReader();
    const all = await reader.listMarkets();
    const coll = (dex: string) => [...new Set(all.filter((m) => m.dex === dex).map((m) => m.collateralAsset))];
    for (const d of ["xyz", "io", "para"]) expect(coll(d)).toEqual(["USDC"]);
    for (const d of ["flx", "vntl", "km"]) expect(coll(d)).toEqual(["USDH"]);
    expect(coll("hyna")).toEqual(["USDE"]);
    expect(coll("cash")).toEqual(["USDT0"]);
    // an unknown collateral token id is labelled and never executable
    const meta = fx("metaAndAssetCtxs_abcd");
    const { reader: r2 } = fixtureReader((b) => (b.type === "metaAndAssetCtxs" && b.dex === "abcd" ? [{ ...meta[0], collateralToken: 9999 }, meta[1]] : undefined));
    const abcd = (await r2.listMarkets()).filter((m) => m.dex === "abcd");
    expect(abcd.length).toBeGreaterThan(0);
    for (const m of abcd) {
      expect(m.collateralAsset).toBe("TOKEN:9999");
      expect(m.executable).toBe(false);
    }
  });

  test("margin-modes", async () => {
    const { reader } = fixtureReader();
    const all = await reader.listMarkets();
    const by = (sym: string) => all.find((m) => m.venueSymbol === sym)!;
    expect(by("BTC").marginModes).toEqual(["cross", "isolated"]);
    expect(by("io:OAI").marginModes).toEqual(["isolated"]); // onlyIsolated + noCross
    expect(by("para:H100").marginModes).toEqual(["isolated"]); // strictIsolated
    expect(by("xyz:HOOD").marginModes).toEqual(["isolated"]);
    expect(by("xyz:XYZ100").marginModes).toEqual(["cross", "isolated"]);
    expect(marginModesOf({ name: "x", szDecimals: 1, maxLeverage: 3, marginMode: "noCross" })).toEqual(["isolated"]);
    expect(marginModesOf({ name: "x", szDecimals: 1, maxLeverage: 3, marginMode: "strictIsolated" })).toEqual(["isolated"]);
    expect(marginModesOf({ name: "x", szDecimals: 1, maxLeverage: 3, onlyIsolated: true })).toEqual(["isolated"]);
    expect(marginModesOf({ name: "x", szDecimals: 1, maxLeverage: 3, onlyIsolated: false })).toEqual(["cross", "isolated"]);
  });

  test("max-builder-fee-unit", async () => {
    const { reader } = fixtureReader();
    const builder = fx<string[]>("approvedBuilders_userA")[0]! as `0x${string}`;
    const v = await reader.maxBuilderFee(USER_A, builder);
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBe(fx<number>("maxBuilderFee_userA"));
    expect(v / 10).toBe(100); // tenths of a bp: 1000 = 100 bps (this account approved the spot ceiling)
    expect(await reader.maxBuilderFee(USER_A, "0x00000000000000000000000000000000c0ffee01")).toBe(0);
    const { reader: r85 } = fixtureReader((b) => (b.type === "maxBuilderFee" ? 85 : undefined));
    expect((await r85.maxBuilderFee(USER_A, builder)) / 10).toBe(8.5);
    const { reader: bad } = fixtureReader((b) => (b.type === "maxBuilderFee" ? 8.5 : undefined));
    await expect(bad.maxBuilderFee(USER_A, builder)).rejects.toThrow(CapstanError);
  });

  test("unknown-type", async () => {
    const srv = fakeVenueServer({ "POST /info": () => errorResponse("hyperliquid", "error_unknownType") });
    try {
      const http = venueHttp("hyperliquid", srv.url, createMemoryGovernor("t"), { maxTries: 1 });
      const reader = createHlReader(CFG, http, memoryMarketDataCache());
      let err: unknown;
      try {
        await reader.approvedBuilders(USER_A);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HlUnknownInfoType);
      expect((err as HlUnknownInfoType).code).toBe("VENUE_ERROR");
      expect((err as HlUnknownInfoType).venueCode).toBe("UNKNOWN_INFO_TYPE");
      // the same text in a 200 body is also an unknown type, never an empty list
      const { reader: r2 } = fixtureReader((b) => (b.type === "extraAgents" ? "Failed to deserialize the JSON body into the target type" : undefined));
      await expect(r2.extraAgents(USER_A)).rejects.toBeInstanceOf(HlUnknownInfoType);
    } finally {
      srv.stop();
    }
  });
});
