// Lighter mainnet (signing id 304) markets for the nightly catalog sync: every book, perps and spot, inactive ones
// included (they become delisted rows). Market type comes from the venue's market_type string; spot never executes.
import { lighterConfigsFor, lighterReaderFor } from "@capstan/adapter-lighter";
import type { MarketSource } from "@capstan/catalog";
import { catalogGovernor } from "./governor";

export const source: MarketSource = {
  venue: "lighter-mainnet",
  listMarkets: () => lighterReaderFor(lighterConfigsFor(process.env)[0], catalogGovernor(), null).listMarkets(),
};
