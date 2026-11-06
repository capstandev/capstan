import { describe, expect, test } from "bun:test";
import { VENUE_IDS, VenueIdSchema, type BuilderFeeRail, type VenueCapabilities } from "./adapter";
import { BUILDER_FEE_DEFAULTS, LIGHTER_INTEGRATOR_CAP_BPS } from "./constants/venues";

describe("schema/adapter", () => {
  test("venue ids are the six from the spec", () => {
    expect([...VENUE_IDS]).toEqual(["hyperliquid", "lighter-mainnet", "lighter-rh", "aster", "variational", "arcus"]);
  });
  test("VenueIdSchema refuses unknown venues", () => {
    expect(VenueIdSchema.safeParse("hyperliquid").success).toBe(true);
    expect(VenueIdSchema.safeParse("dydx").success).toBe(false);
  });
  test("canWithdraw-literal", () => {
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
    const flag = Math.random() > 2; // a runtime boolean, not a literal
    // @ts-expect-error a plain boolean is not the literal false either
    const widened: VenueCapabilities = { ...caps, canWithdraw: flag };
    // @ts-expect-error the field is required
    const missing: VenueCapabilities = { ...caps, canWithdraw: undefined };
    expect(caps.canWithdraw).toBe(false);
    expect(bad && widened && missing).toBeDefined();
  });
  test("Lighter integrator rail: caps 10 bps (304) and 100 bps (466324), charge 0", () => {
    expect(LIGHTER_INTEGRATOR_CAP_BPS).toEqual({ "lighter-mainnet": 10, "lighter-rh": 100 });
    expect(BUILDER_FEE_DEFAULTS["lighter-mainnet"]).toMatchObject({ kind: "lighter_integrator", unit: "ppm", capBps: 10, chargeBps: 0 });
    expect(BUILDER_FEE_DEFAULTS["lighter-rh"]).toMatchObject({ kind: "lighter_integrator", unit: "ppm", capBps: 100, chargeBps: 0 });
    const rail: BuilderFeeRail = { ...BUILDER_FEE_DEFAULTS["lighter-rh"], approvalSignedBy: "main_wallet", builderAddress: "0x0000000000000000000000000000000000000002" };
    expect(rail.kind).toBe("lighter_integrator");
  });
});
