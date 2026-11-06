// R10: not enough collateral on the market's dex gives HL_COLLATERAL_REQUIRED with an own-account move step.
import { describe, expect, test } from "bun:test";
import { buildOrder, HlCollateralRequired } from "../../src";
import { ctx, EMPTY_OWNER, hip3Setup, intent } from "./util";

describe("collateral", () => {
  test("hint-step", async () => {
    const h = hip3Setup();
    const c = ctx({ owner: EMPTY_OWNER, identity: { venue: "hyperliquid", owner: EMPTY_OWNER, agentAddress: ctx().identity.agentAddress } });
    const err = await buildOrder(intent({ leverage: 5 }), c, h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(HlCollateralRequired);
    expect(err.hint).toBe("HL_COLLATERAL_REQUIRED");
    expect(err.step.kind).toBe("hl_collateral_move");
    expect(err.step.signer).toBe("main_wallet");
    expect(err.step.typedData.message.destination).toBe(EMPTY_OWNER);
    expect(err.step.typedData.message.destinationDex).toBe("xyz");
    expect(err.step.typedData.message.sourceDex).toBe("");
    expect(err.step.typedData.message.token).toBe("USDC");
    expect(Number(err.shortfall)).toBeGreaterThan(0);
    // userA has xyz collateral: no hint
    await expect(buildOrder(intent({ leverage: 5 }), ctx(), h.deps)).resolves.toBeDefined();
    // closing orders never need it
    await expect(buildOrder(intent({ reduceOnly: true, side: "sell" }), c, h.deps)).resolves.toBeDefined();
  });
});
