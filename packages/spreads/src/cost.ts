// Round-trip cost of a two-leg funding-rate spread trade: open and close on both legs, each counting the venue fee,
// Capstan's builder fee (HL 2 bps, Aster 2 bps, Lighter 0) and the slippage at the requested size. Funding is not a
// cost here (it is the observed difference the trade is about). Summed exactly at 4 decimals.
import type { VenueQuote } from "@capstan/schema";

export type CostQuote = Pick<VenueQuote, "venueFeeBps" | "builderFeeBps" | "slippageBps">;

export function legCostBps(q: CostQuote): number {
  return q.venueFeeBps + q.builderFeeBps + q.slippageBps;
}

export function roundTripCostBps(legA: CostQuote, legB: CostQuote, closeA: CostQuote, closeB: CostQuote): number {
  let t = 0n;
  for (const q of [legA, legB, closeA, closeB]) for (const x of [q.venueFeeBps, q.builderFeeBps, q.slippageBps]) {
    if (!Number.isFinite(x) || x < 0) throw new RangeError("cost parts must be non-negative numbers");
    t += BigInt(Math.round(x * 10_000));
  }
  return Number(t) / 10_000;
}
