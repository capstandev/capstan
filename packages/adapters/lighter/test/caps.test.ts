// R12: capabilities for both configs.
import { describe, expect, test } from "bun:test";
import { LIGHTER_CONFIGS, lighterCaps, lighterExecutionEnabled } from "../src";

describe("caps", () => {
  test("caps", () => {
    for (const [cfg, cap] of [
      [LIGHTER_CONFIGS.mainnet, 10],
      [LIGHTER_CONFIGS.rh, 100],
    ] as const) {
      const c = lighterCaps(cfg, { execution: true });
      expect(c).toMatchObject({
        venue: cfg.venue,
        execution: true,
        keyType: "lighter-native",
        delegation: "api_key_index",
        canWithdraw: false,
        builderFee: { kind: "lighter_integrator", unit: "ppm", capBps: cap, chargeBps: 0, approvalSignedBy: "main_wallet" },
        signingDomain: { chainId: cfg.signingChainId },
        publicAccountReads: true,
      });
    }
    expect(lighterCaps(LIGHTER_CONFIGS.rh).collateral).toEqual(["USDG", "STOCK_TOKENS"]);
    expect(lighterCaps(LIGHTER_CONFIGS.mainnet).collateral).toEqual(["USDC"]);
    // execution follows the LIGHTER_EXECUTION flag, off unless set
    expect(lighterExecutionEnabled({})).toBe(false);
    expect(lighterExecutionEnabled({ LIGHTER_EXECUTION: "0" })).toBe(false);
    expect(lighterExecutionEnabled({ LIGHTER_EXECUTION: "1" })).toBe(true);
  });
});
