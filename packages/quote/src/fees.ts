// Fee columns (R10). Venue fee: the owner's tier when known, else the venue's base taker fee. Builder fee: what Capstan
// charges: HL 2 bps (1 bp lock tier), Aster 2 bps (1 bp), Lighter 0, data-only venues 0. HIP-3 charges what HL core
// charges (DECISIONS #31: on by default, mainnet evidence) and 0 on a dex the per-dex gate has switched off, the same
// gate adapter-hyperliquid's HIP-3 hook reads (createHip3Gate().builderFeeSupported). Builder fees are Capstan's own and never fold into the venue fee.
import { BUILDER_FEE_DEFAULTS, type Hex, type Market, type VenueId } from "@capstan/schema";

export interface FeeTier {
  takerBps: number;
  source: "owner" | "base";
  tier?: string;
}

/** Base taker fees per venue (bps), each from the venue research. */
export const BASE_TAKER_BPS: Record<VenueId, number> = {
  hyperliquid: 4.5, // tier 0 taker 0.045% (venue-hyperliquid.md fees, live userFees.feeSchedule 2026-11-06)
  "lighter-mainnet": 0, // Standard tier 0 / 0 (venue-lighter.md fee schedule, 2026-11-05)
  "lighter-rh": 0, // Standard tier 0 / 0 (docs; the RH feeTiers endpoint answers 403)
  aster: 3.5, // base taker 0.035% (venue-aster.md, the Aster adapter's ASTER_BASE_TAKER_BPS)
  arcus: 4.5, // base taker 450 ppm (venue-readonly.md section 2.2)
  variational: 0, // no fee is published; the spread sits inside the size-bucketed quotes
};

export async function baseFeeTier(_owner: Hex | undefined, venue: VenueId): Promise<FeeTier> {
  return { takerBps: BASE_TAKER_BPS[venue], source: "base" };
}

/**
 * HIP-3 taker fee from the core tier: the deployer adds deployerFeeScale x base (0 to 300%); above 100% the protocol
 * share rises to match, so the total is base x (max(1, s) + s). Growth mode cuts the whole fee to one tenth
 * (venue-hyperliquid.md rows 106 and 107: xyz:GOLD without growth mode paid 9 bps, 2x core; growth mode 0.45 to 0.9 bps).
 */
export function hip3TakerBps(coreTakerBps: number, m: Pick<Market, "deployerFeeScale" | "growthMode">): number {
  const s = m.deployerFeeScale !== undefined && m.deployerFeeScale !== null ? Number(m.deployerFeeScale) : 1;
  const scale = Number.isFinite(s) && s >= 0 ? s : 1;
  const raw = coreTakerBps * (Math.max(1, scale) + scale) * (m.growthMode ? 0.1 : 1);
  return Math.round(raw * 10_000) / 10_000;
}

export function venueFeeBpsFor(tier: FeeTier, m: Pick<Market, "venue" | "dex" | "deployerFeeScale" | "growthMode">): number {
  if (m.venue === "hyperliquid" && m.dex !== null) return hip3TakerBps(tier.takerBps, m);
  return tier.takerBps;
}

export interface BuilderFeeOptions {
  /** True when the owner holds the CPST lock tier (1 bp on HL and Aster). */
  lockTier?: (owner: Hex | undefined) => boolean | Promise<boolean>;
  /**
   * HIP-3 per-dex builder gate. Pass the adapter's gate.builderFeeSupported so the quote and the build agree. Default:
   * every dex on (DECISIONS #31); a dex it answers false for carries 0.
   */
  hip3BuilderFeeSupported?: (dex: string) => boolean;
}

export type BuilderFeeFn = (owner: Hex | undefined, venue: VenueId, market?: Pick<Market, "dex">) => Promise<number>;

export function defaultBuilderFeeBps(o: BuilderFeeOptions = {}): BuilderFeeFn {
  return async (owner, venue, market) => {
    if (venue === "variational" || venue === "arcus") return 0;
    if (venue === "lighter-mainnet" || venue === "lighter-rh") return BUILDER_FEE_DEFAULTS[venue].chargeBps; // 0
    if (venue === "hyperliquid" && market && market.dex !== null && o.hip3BuilderFeeSupported && !o.hip3BuilderFeeSupported(market.dex)) return 0;
    const lock = o.lockTier ? await o.lockTier(owner) : false;
    const full = venue === "hyperliquid" ? BUILDER_FEE_DEFAULTS.hyperliquid.chargeBps : BUILDER_FEE_DEFAULTS.aster.chargeBps;
    return lock ? full / 2 : full;
  };
}
