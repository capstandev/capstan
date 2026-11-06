// Variational catalog source: every listing in GET /metadata/v2/stats (perps and the 24 h swaps). Data only: every
// market enters with executable false and dataFreshness 'delayed'; non-crypto tickers carry a class hint.
import { defaultVariationalAdapter, type VariationalAdapter } from "@capstan/adapter-variational";
import type { MarketSource } from "@capstan/catalog";

export function variationalSource(getAdapter: () => Pick<VariationalAdapter, "listMarkets">): MarketSource {
  return { venue: "variational", listMarkets: () => getAdapter().listMarkets() };
}

let adapter: VariationalAdapter | null = null;
export const source: MarketSource = variationalSource(() => (adapter ??= defaultVariationalAdapter()));
