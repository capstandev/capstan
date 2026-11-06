// Estimated isolated liquidation price (R12). Only venues whose margin model is implemented get a number:
//   liquidation when equity = maintenance margin, with isolated margin = entry x size / leverage:
//   long  liq = entry x (1 - 1/lev) / (1 - mmf)      short liq = entry x (1 + 1/lev) / (1 + mmf)
// Hyperliquid: mmf from meta, else half the initial margin at max leverage (1 / (2 x maxLeverage), HL docs Liquidations page; recorded in research/venue-hyperliquid.md section 3).
// Lighter: mmf from orderBookDetails maintenance_margin_fraction (per 10,000), carried on the market.
// Every other venue (Aster, data-only) returns null: the UI shows "venue computes it". Never a guess.
import { Dec, type Market, type VenueId } from "@capstan/schema";
import { d, str } from "./dec";

/** A market as the quote engine reads it: the catalog row plus margin facts some adapters publish. */
export type QuoteMarket = Market & { maintenanceMarginFraction?: string | null };

export const LIQ_MODELS: readonly VenueId[] = ["hyperliquid", "lighter-mainnet", "lighter-rh"];

export function maintenanceFraction(venue: VenueId, m: QuoteMarket): string | null {
  if (m.maintenanceMarginFraction) return m.maintenanceMarginFraction;
  if (venue === "hyperliquid" && m.maxLeverage && m.maxLeverage > 0) return str(Dec.div(Dec.parse("1", 0), Dec.parse(String(2 * m.maxLeverage), 0), 18, "half_even"));
  return null;
}

export function estLiqPx(venue: VenueId, m: QuoteMarket, entryPx: string, leverage: number, side: "buy" | "sell"): string | null {
  if (!LIQ_MODELS.includes(venue)) return null;
  if (!Number.isFinite(leverage) || leverage <= 0) return null;
  if (m.maxLeverage !== null && leverage > m.maxLeverage) return null;
  const mmfS = maintenanceFraction(venue, m);
  if (mmfS === null) return null;
  const one = Dec.parse("1", 18);
  const mmf = d(mmfS);
  const inv = Dec.div(one, Dec.parse(String(leverage), 12, "half_even"), 18, "half_even");
  if (Dec.cmp(inv, mmf) <= 0) return null; // margin at or under maintenance: no meaningful price
  const e = d(entryPx);
  const px = side === "buy" ? Dec.div(Dec.mul(e, Dec.sub(one, inv), 18), Dec.sub(one, mmf), 8, "half_even") : Dec.div(Dec.mul(e, Dec.add(one, inv), 18), Dec.add(one, mmf), 8, "half_even");
  if (Dec.cmp(px, Dec.parse("0", 0)) <= 0) return null;
  return str(px);
}
