// Canonical venue types shared by every adapter. Subset of the adapter interface; the rest lands with milestone A0/A1.
import { z } from "zod";

export const VENUE_IDS = [
  "hyperliquid", // core + every HIP-3 dex, told apart by Market.dex
  "lighter-mainnet", // signing ID 304
  "lighter-rh", // signing ID 466324
  "aster",
  "variational", // read-only
  "arcus", // read-only
] as const;

export type VenueId = (typeof VENUE_IDS)[number];
export const VenueIdSchema = z.enum(VENUE_IDS);

export type KeyType = "secp256k1" | "lighter-native" | "ed25519" | "stark" | "cosmos";
export type Delegation = "agent" | "api_key_index" | "subkey" | "permissioned_key" | "session_key" | "none";
export type Hex = `0x${string}`;

export interface BuilderFeeRail {
  kind: "hl_builder_code" | "aster_code";
  unit: "tenths_bp" | "decimal_rate"; // HL f in tenths of a bp; Aster decimal (0.0002 = 2 bps)
  capBps: number;
  approvalSignedBy: "main_wallet"; // never the delegated key
  builderAddress: Hex;
}

export interface VenueCapabilities {
  venue: VenueId;
  execution: boolean; // false for variational, arcus
  keyType: KeyType | null;
  delegation: Delegation;
  canWithdraw: false; // invariant 2: a type-level literal, no adapter may declare true
  builderFee: BuilderFeeRail | null; // null for Lighter
  collateral: string[];
  directSubmitSupported: boolean;
  publicAccountReads: boolean;
  signingDomain?: { chainId: number; name?: string };
}

export interface VenueIdentity {
  venue: VenueId;
  owner: Hex; // main wallet address (public)
  accountIndex?: number; // Lighter
  agentAddress?: Hex; // public address of the delegated key
  apiKeyIndex?: number; // Lighter 4-156 | 158-254
}
