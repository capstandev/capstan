// R9: isolated-only markets build isolated and refuse a cross leverage update.
import { describe, expect, test } from "bun:test";
import { l1Digest } from "@capstan/signer-hl";
import { buildLeverageUpdate, buildOrder } from "../../src";
import { ctx, hip3Setup, intent } from "./util";

describe("margin", () => {
  test("isolated-only", async () => {
    const h = hip3Setup();
    const oai = await h.reader.instrument("hyperliquid:io:OAI");
    expect(oai.marginModes).toEqual(["isolated"]);
    expect(() => buildLeverageUpdate(oai, 3, true, ctx(), h.deps)).toThrow(/isolated-only/);
    const u = buildLeverageUpdate(oai, 3, false, ctx(), h.deps);
    expect(u.action).toEqual({ type: "updateLeverage", asset: 200000, isCross: false, leverage: 3 });
    expect(u.digest).toBe(l1Digest(u.action, null, u.nonce, "Mainnet", u.expiresAfter));
    expect(() => buildLeverageUpdate(oai, 100, false, ctx(), h.deps)).toThrow(/leverage/);
    // a market that allows cross can take it
    const x = await h.reader.instrument("hyperliquid:xyz:XYZ100");
    expect(buildLeverageUpdate(x, 5, true, ctx(), h.deps).action.isCross).toBe(true);
    // the order on an isolated-only market says so
    const b = await buildOrder(intent({ marketId: "hyperliquid:io:OAI", size: "0.1" }), ctx(), h.deps);
    expect(b.preview.warnings).toContain("isolated margin only");
  });
});
