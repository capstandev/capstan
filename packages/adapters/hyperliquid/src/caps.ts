// Adapter capabilities (spec 2): Hyperliquid executes through an agent key; the builder approval is signed by the
// main wallet; the adapter never asks for withdraw permission.
import type { Hex, VenueCapabilities } from "@capstan/schema";
import { HL_COLLATERAL } from "./meta";

export function hlCaps(builderAddress: Hex): VenueCapabilities {
  return {
    venue: "hyperliquid",
    execution: true,
    keyType: "secp256k1",
    delegation: "agent",
    canWithdraw: false,
    builderFee: { kind: "hl_builder_code", unit: "tenths_bp", capBps: 10, approvalSignedBy: "main_wallet", builderAddress: builderAddress.toLowerCase() as Hex },
    collateral: [...HL_COLLATERAL],
    directSubmitSupported: true,
    publicAccountReads: true,
  };
}
