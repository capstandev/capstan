// R11: equity detection for the AE rule; unknown is equity (fail closed). Equity execution needs the flag.
import { describe, expect, test } from "bun:test";
import { buildOrder, isEquityMarket } from "../../src";
import { ctx, hip3Setup, intent } from "./util";

describe("equity", () => {
  test("fail-closed", async () => {
    expect(isEquityMarket({ canonicalAsset: "EQ:TSLA", dex: "xyz" })).toBe(true);
    expect(isEquityMarket({ canonicalAsset: "ETF:SPY", dex: "xyz" })).toBe(true);
    expect(isEquityMarket({ canonicalAsset: "IX:NDX", dex: "xyz" })).toBe(true);
    expect(isEquityMarket({ canonicalAsset: "CR:BTC", dex: "xyz" })).toBe(false);
    expect(isEquityMarket({ canonicalAsset: "CM:GOLD", dex: "xyz" })).toBe(false);
    expect(isEquityMarket({ canonicalAsset: null, dex: "xyz" })).toBe(true);
    expect(isEquityMarket({ canonicalAsset: null, dex: "xyz", assetClassHint: "CR" })).toBe(false);
    expect(isEquityMarket({ canonicalAsset: null, dex: "para", assetClassHint: null })).toBe(true);
    // with the flag off (the default), an unmapped xyz market cannot open
    const off = hip3Setup(undefined, { eqExecutionAllowed: () => false });
    expect((await buildOrder(intent(), ctx(), off.deps).catch((e) => e)).message).toMatch(/equity/);
    const on = hip3Setup();
    await expect(buildOrder(intent(), ctx(), on.deps)).resolves.toBeDefined();
  });
});
