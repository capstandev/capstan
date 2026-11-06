// Aster catalog source: every symbol exchangeInfo lists (TRADING, SETTLING, PENDING_TRADING, ...), mapped by the
// adapter. Stock perps carry assetClassHint EQ and are never auto-mapped. Every market enters non-executable.
import { defaultAsterReader, type AsterReader } from "@capstan/adapter-aster";
import type { MarketSource } from "@capstan/catalog";

/** A source over a given reader (tests pass one bound to a fake venue). */
export function asterSource(getReader: () => AsterReader): MarketSource {
  return {
    venue: "aster",
    listMarkets: () => getReader().listMarkets(),
  };
}

let reader: AsterReader | null = null;
export const source: MarketSource = asterSource(() => (reader ??= defaultAsterReader()));
