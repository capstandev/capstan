// PINS: what this SDK release trusts without asking the server. Builder addresses per venue and network, the approval
// ceilings (HL "0.03%", Aster "0.0003"), the builder fees a build may carry, the Lighter integrator index, onboarding
// template hashes, the receipt signer keys and the anchor contract. All of it comes from one file, pins.json; a test
// keeps the computed parts equal to scripts/gen-pins.ts, and `assertServerMatchesPins` compares the server's
// /v1/venues answer with these values before anything is signed (DEPLOYMENT_MISMATCH on any difference).
import type { Hex, VenueCapabilities, VenueId } from "@capstan/schema";
import { DEPLOYMENTS } from "@capstan/schema";
import { SdkError } from "./errors";
import raw from "./pins.json";

export type Network = "mainnet" | "testnet";
export type LighterVenueId = "lighter-mainnet" | "lighter-rh";
export type FeeVenueId = "hyperliquid" | "aster";

export interface NetworkPins {
  builders: Record<FeeVenueId, Hex | null>;
  approvalCeilings: { hyperliquid: `${string}%`; aster: string };
  /** HL `f` values in tenths of a bp; Aster `feeRate` decimal strings. */
  allowedFees: { hyperliquid: number[]; aster: string[] };
  lighterIntegratorIndex: Record<LighterVenueId, number | null>;
  lighterSigningIds: Record<LighterVenueId, 304 | 466324 | 300>;
  hlNetwork: "Mainnet" | "Testnet";
  asterNetwork: "Mainnet" | "Testnet";
  /** Accepted onboarding template hashes per venue for this SDK release. */
  templateHashes: Record<FeeVenueId | LighterVenueId, Hex[]>;
  /** Receipt signer addresses (optionally with a validity window). */
  receiptSigners: { address: Hex; from?: string; to?: string }[];
  anchor: { chainId: number; address: Hex | null };
}

export interface Pins {
  sdkRelease: string;
  networks: Record<Network, NetworkPins>;
}

const withPrefix = (h: string): Hex => (h.startsWith("0x") ? (h.toLowerCase() as Hex) : (`0x${h.toLowerCase()}` as Hex));
const lowerOrNull = (a: string | null): Hex | null => (a === null ? null : (a.toLowerCase() as Hex));

function loadNetwork(n: (typeof raw.networks)["mainnet"], chainDefault: number): NetworkPins {
  const anchorFromDeployments = DEPLOYMENTS[chainDefault]?.contracts.CapstanReceiptAnchor?.address ?? null;
  return {
    builders: { hyperliquid: lowerOrNull(n.builders.hyperliquid), aster: lowerOrNull(n.builders.aster) },
    approvalCeilings: { hyperliquid: n.approvalCeilings.hyperliquid as `${string}%`, aster: n.approvalCeilings.aster },
    allowedFees: { hyperliquid: [...n.allowedFees.hyperliquid], aster: [...n.allowedFees.aster] },
    lighterIntegratorIndex: { ...n.lighterIntegratorIndex },
    lighterSigningIds: { ...n.lighterSigningIds } as NetworkPins["lighterSigningIds"],
    hlNetwork: n.hlNetwork as NetworkPins["hlNetwork"],
    asterNetwork: n.asterNetwork as NetworkPins["asterNetwork"],
    templateHashes: Object.fromEntries(Object.entries(n.templateHashes).map(([k, v]) => [k, (v as string[]).map(withPrefix)])) as NetworkPins["templateHashes"],
    receiptSigners: (n.receiptSigners as { address: string; from?: string; to?: string }[]).map((s) => ({ ...s, address: s.address.toLowerCase() as Hex })),
    anchor: { chainId: n.anchor.chainId, address: lowerOrNull(n.anchor.address ?? anchorFromDeployments) },
  };
}

export const PINS: Pins = Object.freeze({
  sdkRelease: raw.sdkRelease,
  networks: { mainnet: loadNetwork(raw.networks.mainnet, 4663), testnet: loadNetwork(raw.networks.testnet, 46630) },
}) as Pins;

export type PinsOverride = { sdkRelease?: string; networks?: Partial<Record<Network, Partial<NetworkPins>>> };

/** Pins with a caller's override (tests, self-hosters with their own builder). Override wins field by field. */
export function mergePins(base: Pins, o?: PinsOverride): Pins {
  if (!o) return base;
  const net = (n: Network): NetworkPins => ({ ...base.networks[n], ...(o.networks?.[n] ?? {}) });
  return { sdkRelease: o.sdkRelease ?? base.sdkRelease, networks: { mainnet: net("mainnet"), testnet: net("testnet") } };
}

/** The pinned builder for a fee venue, or a refusal when this release has none (never a server-supplied fallback). */
export function pinnedBuilder(p: NetworkPins, venue: FeeVenueId): Hex {
  const b = p.builders[venue];
  if (!b) throw new SdkError("DEPLOYMENT_MISMATCH", `no ${venue} builder is pinned in this SDK release`, { field: "builder" });
  return b;
}

const HL_CAP_BPS = 10;
const ASTER_CAP_BPS = 10;

/**
 * Compare GET /v1/venues with the pins: the builder address of every fee venue, the venue fee caps, and the Lighter
 * charge (0). Any difference throws DEPLOYMENT_MISMATCH naming the venue and field.
 */
export function assertServerMatchesPins(venues: VenueCapabilities[], p: NetworkPins): void {
  const by = new Map<VenueId, VenueCapabilities>(venues.map((v) => [v.venue, v]));
  const fail = (venue: string, field: string, why: string): never => {
    throw new SdkError("DEPLOYMENT_MISMATCH", `${venue} ${field}: ${why}`, { field: `${venue}.${field}` });
  };
  for (const v of venues) if (v.canWithdraw !== false) fail(v.venue, "canWithdraw", "a venue declares withdraw");
  for (const venue of ["hyperliquid", "aster"] as const) {
    const c = by.get(venue);
    const pin = p.builders[venue];
    if (!c) continue; // a venue the server does not offer is simply not used
    const rail = c.builderFee;
    if (!rail) {
      if (pin) fail(venue, "builderFee", "the server lists no builder rail");
      continue;
    }
    if (!pin) fail(venue, "builderAddress", "this SDK release pins no builder for this venue");
    if (rail.builderAddress.toLowerCase() !== pin) fail(venue, "builderAddress", "differs from the pinned builder");
    if (rail.approvalSignedBy !== "main_wallet") fail(venue, "approvalSignedBy", "must be the main wallet");
    const cap = venue === "hyperliquid" ? HL_CAP_BPS : ASTER_CAP_BPS;
    if (rail.capBps !== cap) fail(venue, "capBps", `expected ${cap}`);
    if (rail.chargeBps !== undefined && rail.chargeBps > 3) fail(venue, "chargeBps", "above the 3 bps approval ceiling");
  }
  for (const venue of ["lighter-mainnet", "lighter-rh"] as const) {
    const c = by.get(venue);
    if (!c?.builderFee) continue;
    if ((c.builderFee.chargeBps ?? 0) !== 0) fail(venue, "chargeBps", "Lighter must charge 0");
  }
}
