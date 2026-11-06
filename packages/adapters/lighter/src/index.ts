// @capstan/adapter-lighter: Lighter adapter for the mainnet (signing id 304) and Robinhood Chain (466324) exchanges.
import type { MarketDataCache } from "@capstan/core";
import { venueHttp, type Governor } from "@capstan/venue-client";
import { createLighterAdapter, type LighterAdapter, type LighterAdapterDeps } from "./adapter";
import { lighterConfig, type LighterConfigName } from "./config";

export * from "./adapter";
export * from "./config";
export * from "./fees";
export * from "./ingest";
export * from "./keyindex";
export * from "./nonce";
export * from "./normalize";
export * from "./onboarding";
export * from "./orders";
export * from "./read";
export * from "./revocation";
export * from "./submit";
export * from "./verify";

export interface CreateAdapterConfig extends Omit<LighterAdapterDeps, "http"> {
  config: LighterConfigName;
  gov: Governor;
  cache: MarketDataCache | null;
  /** Override the REST base (tests, a local proxy). */
  rest?: string;
}

/** The composition entry point (apps/api/src/adapters.ts calls this once per config). */
export function createAdapter(c: CreateAdapterConfig): LighterAdapter {
  const cfg = lighterConfig(c.config);
  const http = venueHttp(cfg.governorKey, c.rest ?? cfg.rest, c.gov, { userAgent: "capstan-lighter" });
  return createLighterAdapter(cfg, { ...c, http });
}
export * from "./rh";
