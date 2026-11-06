import { describe, expect, test } from "bun:test";
import { arcusWeight, asterWeight, hlExchangeWeight, hlInfoWeight } from "../src/budgets";
import { defaultCost } from "../src/http";

describe("weights", () => {
  test("hl-weights", () => {
    expect(hlInfoWeight("l2Book")).toBe(2);
    expect(hlInfoWeight("metaAndAssetCtxs")).toBe(20);
    expect(hlInfoWeight("userRole")).toBe(60);
    expect(hlInfoWeight("userFills", 45)).toBe(20 + 2);
    expect(hlInfoWeight("clearinghouseState")).toBe(2);
    expect(hlInfoWeight("allMids")).toBe(2);
    expect(hlInfoWeight("candleSnapshot", 130)).toBe(22);
    expect(hlExchangeWeight(1)).toBe(1);
    expect(hlExchangeWeight(40)).toBe(2);
    expect(hlExchangeWeight(79)).toBe(2);
    expect(defaultCost("hyperliquid", "POST", "/info", {}, { type: "l2Book", coin: "BTC" })).toBe(2);
    expect(defaultCost("hyperliquid", "POST", "/exchange", {}, { action: { type: "order", orders: new Array(80).fill({}) } })).toBe(3);
  });
  test("aster and arcus weights", () => {
    expect(asterWeight("/fapi/v3/fundingInfo")).toBe(10);
    expect(asterWeight("/fapi/v3/premiumIndex")).toBe(10);
    expect(asterWeight("/fapi/v3/premiumIndex", { symbol: "BTCUSDT" })).toBe(1);
    expect(asterWeight("/fapi/v3/depth", { limit: 5 })).toBe(2);
    expect(asterWeight("/fapi/v3/depth", { limit: 1000 })).toBe(20);
    expect(arcusWeight("/v1/markets")).toBe(20);
    expect(arcusWeight("/v1/bbo/BTC-USD")).toBe(2);
    expect(arcusWeight("/v1/fundingRates", 45)).toBe(22);
    expect(arcusWeight("/health")).toBe(0);
  });
});
