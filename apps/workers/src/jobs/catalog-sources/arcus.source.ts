// Arcus catalog source: every market in GET /v1/markets (ONLINE and OFFLINE). Data only: executable false; the venue
// category (CRYPTO, EQUITIES, INDICES, COMMODITIES) becomes the class hint, so real-world markets are proposal-only.
import { defaultArcusAdapter, type ArcusAdapter } from "@capstan/adapter-arcus";
import type { MarketSource } from "@capstan/catalog";

export function arcusSource(getAdapter: () => Pick<ArcusAdapter, "listMarkets">): MarketSource {
  return { venue: "arcus", listMarkets: () => getAdapter().listMarkets() };
}

let adapter: ArcusAdapter | null = null;
export const source: MarketSource = arcusSource(() => (adapter ??= defaultArcusAdapter()));
