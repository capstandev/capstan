// Which network each venue reads and trades on, from one setting (CAPSTAN_NETWORK: local, testnet or mainnet).
// On local and testnet every venue that has a testnet uses it; a venue with no testnet (Variational) reads its public
// mainnet host, and that data is labelled mainnet read-only everywhere it is shown (profile, /v1/venues). Mainnet uses
// every venue's mainnet. Every caller picks hosts from here, so one profile never mixes networks by accident.
import type { VenueId } from "./adapter";

export type CapstanNetwork = "local" | "testnet" | "mainnet";
export type VenueNetwork = "mainnet" | "testnet";

/** Venues with a public testnet (live checks in venue-*.md, 2026-11-05 and 2026-11-06). */
export const VENUE_HAS_TESTNET: Readonly<Record<VenueId, boolean>> = Object.freeze({
  hyperliquid: true, // api.hyperliquid-testnet.xyz
  "lighter-mainnet": true, // testnet.zklighter.elliot.ai
  "lighter-rh": true, // api.rh-testnet.lighter.xyz
  aster: true, // fapi.asterdex-testnet.com
  arcus: true, // api.testnet.arcus.xyz
  variational: false, // no public testnet: mainnet read-only data
});

/** Per-venue overrides an operator may set; when unset the profile decides. */
export const VENUE_NETWORK_OVERRIDES: Readonly<Partial<Record<VenueId, string>>> = Object.freeze({
  hyperliquid: "HL_NETWORK",
  aster: "CAPSTAN_ASTER_NETWORK",
  arcus: "CAPSTAN_ARCUS_NETWORK",
});

export interface VenueNetworkEntry {
  venue: VenueId;
  network: VenueNetwork;
  /** True when the profile is local or testnet but this venue reads mainnet (no testnet exists): data only. */
  mainnetReadOnly: boolean;
  note: string | null;
}

export function capstanNetwork(env: Record<string, string | undefined>): CapstanNetwork {
  const v = env.CAPSTAN_NETWORK;
  return v === "mainnet" || v === "testnet" ? v : "local";
}

/** The network a venue uses under this environment. */
export function venueNetwork(venue: VenueId, env: Record<string, string | undefined>): VenueNetwork {
  const key = VENUE_NETWORK_OVERRIDES[venue];
  const o = key ? env[key]?.toLowerCase() : undefined;
  if (o === "mainnet" || o === "testnet") return VENUE_HAS_TESTNET[venue] || o === "mainnet" ? o : "mainnet";
  if (capstanNetwork(env) === "mainnet") return "mainnet";
  return VENUE_HAS_TESTNET[venue] ? "testnet" : "mainnet";
}

export const MAINNET_READ_ONLY_NOTE = "No testnet exists for this venue: mainnet market data, read only.";

export function venueNetworkEntry(venue: VenueId, env: Record<string, string | undefined>): VenueNetworkEntry {
  const network = venueNetwork(venue, env);
  const mainnetReadOnly = capstanNetwork(env) !== "mainnet" && network === "mainnet";
  return { venue, network, mainnetReadOnly, note: mainnetReadOnly ? MAINNET_READ_ONLY_NOTE : null };
}

/** Every venue's network under this environment, in VENUE_IDS order. */
export function venueNetworkProfile(env: Record<string, string | undefined>, venues: readonly VenueId[]): VenueNetworkEntry[] {
  return venues.map((v) => venueNetworkEntry(v, env));
}
