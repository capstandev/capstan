// R11: every call passes its info weight; per-row weight is added for fills.
import { describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import { createMemoryGovernor, fakeVenueServer, venueHttp, type Governor } from "@capstan/venue-client";
import { createHlReader } from "../src";
import { CFG, fixtureReader, USER_A } from "./helpers";

describe("governor", () => {
  test("weights-passed", async () => {
    const { reader, http } = fixtureReader();
    await reader.getBook("hyperliquid:-:BTC");
    await reader.getAccount({ venue: "hyperliquid", owner: USER_A });
    await reader.userFills(USER_A, 1793700000000);
    await reader.getFunding("hyperliquid:xyz:TSLA");
    const cost = (t: string) => [...new Set(http.calls.filter((c) => c.body.type === t).map((c) => c.cost))];
    expect(cost("l2Book")).toEqual([2]);
    expect(cost("clearinghouseState")).toEqual([2]);
    expect(cost("metaAndAssetCtxs")).toEqual([20]);
    expect(cost("perpDexs")).toEqual([20]);
    expect(cost("userFillsByTime")).toEqual([20]);
    for (const c of http.calls) expect(typeof c.cost).toBe("number");

    // through the real client: 45 fill rows add floor(45 / 20) = 2 after the response
    const rows = Array.from({ length: 45 }, (_, i) => ({ coin: "BTC", px: "1", sz: "1", side: "B", time: i, oid: i, fee: "0" }));
    const srv = fakeVenueServer({ "POST /info": () => Response.json(rows) });
    try {
      const acquired: number[] = [];
      const g0 = createMemoryGovernor("t");
      const gov: Governor = { ...g0, egress: g0.egress, acquire: (v, c, o) => (acquired.push(c), g0.acquire(v, c, o)), observe: g0.observe, usage: g0.usage, flush: g0.flush };
      const r = createHlReader(CFG, venueHttp("hyperliquid", srv.url, gov), memoryMarketDataCache());
      expect((await r.userFills(USER_A, 0)).length).toBe(45);
      expect(acquired).toEqual([20, 2]);
    } finally {
      srv.stop();
    }
  });
});
