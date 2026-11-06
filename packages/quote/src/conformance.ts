// QUOTE-1 conformance: a quote leg must carry exactly the size, limit price and fee columns the venue adapter's own
// buildOrder puts in its preview for the same intent at the same instant on the same cached book. test/quote1.test.ts
// runs it against the Aster, Hyperliquid (core and HIP-3) and Lighter (mainnet and Robinhood Chain) builds.
import { Dec, type OrderIntent, type UnsignedVenuePayload } from "@capstan/schema";
import type { QuoteRequest } from "@capstan/schema";
import type { EngineLeg } from "./route";
import { DEFAULT_MARKET_SLIPPAGE_BPS } from "./shape";

/** The order a quote leg stands for: what a user who accepts the quote asks the venue to build. */
export function intentForLeg(req: QuoteRequest, leg: EngineLeg, maxSlippageBps = DEFAULT_MARKET_SLIPPAGE_BPS): OrderIntent {
  return {
    marketId: leg.marketId,
    side: req.side,
    size: leg.sizeBase,
    type: req.orderType,
    ...(req.orderType === "limit" && req.limitPx ? { limitPx: req.limitPx } : {}),
    tif: req.orderType === "market" ? "ioc" : "gtc",
    reduceOnly: false,
    leverage: req.leverage,
    maxSlippageBps,
  };
}

const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Dec.eq(Dec.parse(a, 18, "half_even"), Dec.parse(b, 18, "half_even")));

export function quoteBuildDiffs(leg: EngineLeg, build: UnsignedVenuePayload): string[] {
  const p = build.preview;
  const out: string[] = [];
  if (p.marketId !== leg.marketId) out.push(`marketId ${leg.marketId} != ${p.marketId}`);
  if (!same(leg.sizeBase, p.size)) out.push(`size ${leg.sizeBase} != ${p.size}`);
  if (!same(leg.limitPx, p.px)) out.push(`limitPx ${leg.limitPx} != ${p.px}`);
  if (leg.venueFeeBps !== p.venueFeeBps) out.push(`venueFeeBps ${leg.venueFeeBps} != ${p.venueFeeBps}`);
  if (leg.builderFeeBps !== p.builderFeeBps) out.push(`builderFeeBps ${leg.builderFeeBps} != ${p.builderFeeBps}`);
  if (leg.collateralAsset !== p.collateralAsset) out.push(`collateral ${leg.collateralAsset} != ${p.collateralAsset}`);
  return out;
}
