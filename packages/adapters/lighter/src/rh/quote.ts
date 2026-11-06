// RH quotes are in USDG and stay in USDG: never converted to USDC. Compared against a USDC venue, the comparison
// carries a depeg flag when |USDG/USDC - 1| > 25 bps (the price comes from the feeds work, todo 17).
import { Dec, type VenueQuote } from "@capstan/schema";

export const DEPEG_FLAG_BPS = 25;

export interface RhQuoteView extends VenueQuote {
  collateralAsset: "USDG";
  flags: ("DEPEG_FLAG" | "DEPEG_UNKNOWN")[];
  depegBps: number | null;
}

/** usdgPerUsdc: price of 1 USDG in USDC (null when the feed is stale or missing). */
export function rhQuoteView(q: VenueQuote, compare: { againstCollateral: string; usdgPerUsdc: string | null }): RhQuoteView {
  const flags: RhQuoteView["flags"] = [];
  let depegBps: number | null = null;
  if (compare.againstCollateral !== "USDG") {
    if (compare.usdgPerUsdc === null) flags.push("DEPEG_UNKNOWN");
    else {
      const p = Dec.parse(compare.usdgPerUsdc, 12, "half_even");
      const diff = Dec.abs(Dec.sub(p, Dec.parse("1", 0)));
      depegBps = Number(Dec.toString(Dec.mul(diff, Dec.parse("10000", 0), 4, "half_even")));
      if (depegBps > DEPEG_FLAG_BPS) flags.push("DEPEG_FLAG");
    }
  }
  // the numbers are the venue's, in USDG, untouched
  return { ...q, collateralAsset: "USDG", flags, depegBps };
}
