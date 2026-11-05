import { describe, expect, test } from "bun:test";
import { VENUE_IDS, VenueIdSchema, type VenueCapabilities } from "./adapter";

describe("schema/adapter", () => {
  test("venue ids are the six from the spec", () => {
    expect([...VENUE_IDS]).toEqual(["hyperliquid", "lighter-mainnet", "lighter-rh", "aster", "variational", "arcus"]);
  });
  test("VenueIdSchema refuses unknown venues", () => {
    expect(VenueIdSchema.safeParse("hyperliquid").success).toBe(true);
    expect(VenueIdSchema.safeParse("dydx").success).toBe(false);
  });
  test("canWithdraw is the literal false", () => {
    const caps: VenueCapabilities = {
      venue: "variational",
      execution: false,
      keyType: null,
      delegation: "none",
      canWithdraw: false,
      builderFee: null,
      collateral: [],
      directSubmitSupported: false,
      publicAccountReads: true,
    };
    // @ts-expect-error canWithdraw: true must not type-check
    const bad: VenueCapabilities = { ...caps, canWithdraw: true };
    expect(caps.canWithdraw).toBe(false);
    expect(bad).toBeDefined();
  });
});
