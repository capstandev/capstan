// Capability rule R10 (todo 13).
import { describe, expect, test } from "bun:test";
import { asterCaps, asterExecutionEnabled } from "../src/config";

const BUILDER = "0xF516fddd46548e304E1bce4DB32FeA7C294E56d2" as const;

describe("aster caps", () => {
  test("caps", () => {
    const c = asterCaps(BUILDER, { execution: false });
    expect(c).toMatchObject({
      venue: "aster",
      execution: false,
      keyType: "secp256k1",
      delegation: "agent",
      canWithdraw: false,
      publicAccountReads: false,
      directSubmitSupported: true,
      builderFee: { kind: "aster_code", unit: "decimal_rate", capBps: 10, chargeBps: 2, approvalSignedBy: "main_wallet", builderAddress: BUILDER },
      signingDomain: { chainId: 1666, name: "AsterSignTransaction" },
    });
    expect(c.collateral).toEqual(["USDT", "USD1", "USDC", "U"]);
    // no builder configured: no rail at all (a zero-address rail made every SDK client refuse the server)
    expect(asterCaps("0x0000000000000000000000000000000000000000", { execution: false }).builderFee).toBeNull();
    expect(asterCaps(BUILDER, { execution: true, network: "Testnet" }).signingDomain?.chainId).toBe(714);
    // the execution flag is off unless ASTER_EXECUTION is set
    expect(asterExecutionEnabled({})).toBe(false);
    expect(asterExecutionEnabled({ ASTER_EXECUTION: "0" })).toBe(false);
    expect(asterExecutionEnabled({ ASTER_EXECUTION: "yes" })).toBe(false);
    expect(asterExecutionEnabled({ ASTER_EXECUTION: "1" })).toBe(true);
    expect(asterExecutionEnabled({ ASTER_EXECUTION: "true" })).toBe(true);
    const prev = process.env.ASTER_EXECUTION;
    delete process.env.ASTER_EXECUTION;
    try {
      expect(asterCaps(BUILDER).execution).toBe(false);
    } finally {
      if (prev !== undefined) process.env.ASTER_EXECUTION = prev;
    }
  });
});
