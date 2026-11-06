// Precision rules (venue-hyperliquid.md section 3): a perp price has at most 5 significant figures and at most
// 6 - szDecimals decimals, integer prices always allowed; size has szDecimals decimals. The adapter rounds every
// price and size itself (never the SDK alone).
import { allowedPriceDecimals, formatPrice, formatSize, PERP_MAX_DECIMALS } from "@capstan/signer-hl";

export { formatPrice, formatSize };

export function pxDecimalsMax(szDecimals: number): number {
  return PERP_MAX_DECIMALS - szDecimals;
}

function unit(decimals: number): string {
  return decimals <= 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
}

export function lotSize(szDecimals: number): string {
  return unit(szDecimals);
}

/** Smallest price step at `mark` under the 5-significant-figure rule; without a mark, the finest step allowed. */
export function tickSizeAt(mark: string | null | undefined, szDecimals: number): string {
  if (!mark || !/^\d+(\.\d+)?$/.test(mark) || /^0+(\.0+)?$/.test(mark)) return unit(pxDecimalsMax(szDecimals));
  return unit(allowedPriceDecimals(mark, szDecimals));
}

/** HL minimum order value (docs: $10 notional). */
export const HL_MIN_NOTIONAL_USD = "10";
