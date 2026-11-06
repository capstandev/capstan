// R14: adapter capabilities.
import { describe, expect, test } from "bun:test";
import { hlCaps } from "../src";
import { BUILDER } from "./helpers";

describe("caps", () => {
  test("caps", () => {
    expect(hlCaps(BUILDER)).toEqual({
      venue: "hyperliquid",
      execution: true,
      keyType: "secp256k1",
      delegation: "agent",
      canWithdraw: false,
      builderFee: { kind: "hl_builder_code", unit: "tenths_bp", capBps: 10, approvalSignedBy: "main_wallet", builderAddress: BUILDER },
      collateral: ["USDC", "USDH", "USDE", "USDT0"],
      directSubmitSupported: true,
      publicAccountReads: true,
    });
    expect(hlCaps("0x00000000000000000000000000000000C0FFEE01").builderFee!.builderAddress).toBe(BUILDER);
  });
});
