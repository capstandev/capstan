import type { VenueId } from "../lib/capstan";

export const VENUE_NAMES: Record<VenueId, string> = {
  hyperliquid: "Hyperliquid",
  "lighter-mainnet": "Lighter",
  "lighter-rh": "Lighter on Robinhood Chain",
  aster: "Aster",
  variational: "Variational",
  arcus: "Arcus",
};

/** Venues a user can onboard and route to (Variational and Arcus are data only). */
export const EXECUTION_VENUES: VenueId[] = ["hyperliquid", "lighter-mainnet", "lighter-rh", "aster"];
export const BUILDER_VENUES = new Set<VenueId>(["hyperliquid", "aster"]);

export const venueName = (v: string) => VENUE_NAMES[v as VenueId] ?? v;

export const FEE_FREE_UNAVAILABLE = (venue: string) =>
  `fee_free_unavailable: you declined the builder fee, so Capstan does not build orders for ${venueName(venue)}. Onboard again and approve the capped fee to trade here, or use the open SDK against the venue directly without Capstan.`;
