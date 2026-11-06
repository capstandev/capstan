// Lighter mainnet (signing id 304) markets for the nightly catalog sync: every book, perps and spot, inactive ones
// included (they become delisted rows). Market type comes from the venue's market_type string; spot never executes.
import { lighterReaderFor, LIGHTER_CONFIGS } from "@capstan/adapter-lighter";
import type { MarketSource } from "@capstan/catalog";
import { createMemoryGovernor } from "@capstan/venue-client";

export const source: MarketSource = {
  venue: "lighter-mainnet",
  listMarkets: () => lighterReaderFor(LIGHTER_CONFIGS.mainnet, createMemoryGovernor(process.env.CAPSTAN_EGRESS_ID ?? "local"), null).listMarkets(),
};
