// Lighter on Robinhood Chain (signing id 466324) markets for the nightly catalog sync. RH lists spot books next to
// perps (27 of 94 on 2026-11-05): they are kept with marketType 'spot' and never execute. Market indexes are RH's own.
import { lighterReaderFor, LIGHTER_CONFIGS } from "@capstan/adapter-lighter";
import type { MarketSource } from "@capstan/catalog";
import { createMemoryGovernor } from "@capstan/venue-client";

export const source: MarketSource = {
  venue: "lighter-rh",
  listMarkets: () => lighterReaderFor(LIGHTER_CONFIGS.rh, createMemoryGovernor(process.env.CAPSTAN_EGRESS_ID ?? "local"), null).listMarkets(),
};
