// Canonical-asset proposals (spec 3). Only crypto majors map automatically, and only on an exact symbol. Equities,
// ETFs, indices, rates, commodities and pre-IPO names never map automatically, even when symbols match across venues:
// they get a proposal that a person reviews.
import type { CanonicalAsset, CanonicalClass, Market } from "@capstan/schema";

/**
 * Exact-symbol auto-map list (CR:<SYM>). Kept short on purpose: large, long-lived assets whose ticker means the same
 * coin on every venue. Anything else waits for review.
 */
export const CRYPTO_MAJORS: readonly string[] = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "LTC", "DOT", "BCH", "TRX"];

const QUOTE_SUFFIX = /^([A-Z0-9]+?)(USDT|USDC|USD1|USDF|USD|U)$/;
const DASH_FORM = /^([A-Z0-9]+)[-/](PERP|USD|USDC|USDT|USDG)$/;

/** The base symbol a venue symbol names (BTCUSDT, BTC-PERP, BTC-USD, BTC -> BTC). Case is kept: kBTC stays kBTC. */
export function baseSymbol(venueSymbol: string): string {
  const s = venueSymbol.includes(":") ? venueSymbol.slice(venueSymbol.indexOf(":") + 1) : venueSymbol;
  const dash = DASH_FORM.exec(s);
  if (dash) return dash[1]!;
  const q = QUOTE_SUFFIX.exec(s);
  if (q && q[1]!.length >= 2) return q[1]!;
  return s;
}

export interface Proposal {
  asset: CanonicalAsset | null;
  auto: boolean;
  reason: string;
}

export function proposeCanonical(m: Market): Proposal {
  if (m.marketType !== "perp") return { asset: null, auto: false, reason: `market type ${m.marketType}: not mapped` };
  const base = baseSymbol(m.venueSymbol);
  const hint: CanonicalClass | null = m.assetClassHint ?? null;
  if (hint && hint !== "CR") {
    // Aster stock perps (symbolType 1), Arcus real-world markets: proposal only, never automatic (R9)
    return { asset: `${hint}:${base}` as CanonicalAsset, auto: false, reason: `venue states class ${hint}: proposal for review` };
  }
  if (m.dex !== null) {
    // a HIP-3 deployer's market: its oracle and contract are the deployer's own, so even a major waits for review
    return CRYPTO_MAJORS.includes(base)
      ? { asset: `CR:${base}`, auto: false, reason: `deployer market on ${m.dex}: proposal for review` }
      : { asset: null, auto: false, reason: `deployer market on ${m.dex}: not mapped` };
  }
  if (CRYPTO_MAJORS.includes(base)) return { asset: `CR:${base}`, auto: true, reason: `crypto major ${base}: exact symbol` };
  return { asset: null, auto: false, reason: "not a crypto major: needs review" };
}
