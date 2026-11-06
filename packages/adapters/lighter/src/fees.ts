// Lighter fee tiers for quotes. Fees come from the account tier, not the market (every market's taker_fee and
// maker_fee read "0.0000"). Fee ticks are parts per million: 100 ticks = 1 bp.
import type { LighterVenue } from "./config";

export type LighterTier = "standard" | "plus" | "premium";
export interface LighterFeeRow {
  makerBps: number;
  takerBps: number;
  makerLatencyMs: number;
  takerLatencyMs: number;
}

export const FEE_TICKS_PER_BP = 100;

export const LIGHTER_FEES: Readonly<Record<LighterVenue, Readonly<Record<LighterTier, Readonly<LighterFeeRow>>>>> = Object.freeze({
  "lighter-mainnet": Object.freeze({
    // venue-lighter.md "Fee schedule", 2026-11-05 (live feeTiers + docs): Standard 0/0, 0 ms maker, 300 ms taker
    standard: Object.freeze({ makerBps: 0, takerBps: 0, makerLatencyMs: 0, takerLatencyMs: 300 }),
    // venue-lighter.md "Fee schedule", 2026-11-05: Plus 0.5/0.5 bps, 300 ms taker
    plus: Object.freeze({ makerBps: 0.5, takerBps: 0.5, makerLatencyMs: 0, takerLatencyMs: 300 }),
    // venue-lighter.md "Fee schedule", 2026-11-05: Premium 0.4/2.8 bps, 140 ms taker
    premium: Object.freeze({ makerBps: 0.4, takerBps: 2.8, makerLatencyMs: 0, takerLatencyMs: 140 }),
  }),
  "lighter-rh": Object.freeze({
    // venue-lighter.md "Fee schedule", 2026-11-05 (docs only, RH feeTiers is 403): Standard 0/0, 200 ms maker latency
    standard: Object.freeze({ makerBps: 0, takerBps: 0, makerLatencyMs: 200, takerLatencyMs: 300 }),
    // venue-lighter.md "Fee schedule", 2026-11-05: Plus 1.5/1.5 bps
    plus: Object.freeze({ makerBps: 1.5, takerBps: 1.5, makerLatencyMs: 0, takerLatencyMs: 300 }),
    // venue-lighter.md "Fee schedule", 2026-11-05: Premium 1.2/3.5 bps, 200 ms taker
    premium: Object.freeze({ makerBps: 1.2, takerBps: 3.5, makerLatencyMs: 0, takerLatencyMs: 200 }),
  }),
});

export type TierSource = "live" | "docs";

export interface FeeSchedule {
  venue: LighterVenue;
  tiers: Record<LighterTier, LighterFeeRow>;
  tierSource: TierSource;
}

/** The docs table for a venue (RH always: its feeTiers endpoint answers 403 from CloudFront). */
export function docsSchedule(venue: LighterVenue): FeeSchedule {
  const t = LIGHTER_FEES[venue];
  return { venue, tiers: { standard: { ...t.standard }, plus: { ...t.plus }, premium: { ...t.premium } }, tierSource: "docs" };
}

interface UserTierRaw {
  name?: string;
  maker_fee_ticks?: number;
  taker_fee_ticks?: number;
  taker_latency_ms?: number;
}

/** Live feeTiers (mainnet) to a schedule; latency the endpoint does not state comes from the docs row. */
export function scheduleFromFeeTiers(venue: LighterVenue, body: unknown): FeeSchedule {
  const rows = ((body as { user_tiers?: UserTierRaw[] } | null)?.user_tiers ?? []).filter((r) => typeof r.name === "string");
  const docs = docsSchedule(venue);
  const tiers = { ...docs.tiers };
  let found = 0;
  for (const name of ["standard", "plus", "premium"] as const) {
    const r = rows.find((x) => x.name === name);
    if (!r || typeof r.maker_fee_ticks !== "number" || typeof r.taker_fee_ticks !== "number") continue;
    found++;
    tiers[name] = {
      makerBps: r.maker_fee_ticks / FEE_TICKS_PER_BP,
      takerBps: r.taker_fee_ticks / FEE_TICKS_PER_BP,
      makerLatencyMs: docs.tiers[name].makerLatencyMs,
      takerLatencyMs: typeof r.taker_latency_ms === "number" ? r.taker_latency_ms : docs.tiers[name].takerLatencyMs,
    };
  }
  if (found < 3) return docs; // a partial answer is not trusted
  return { venue, tiers, tierSource: "live" };
}

/** The fee row a quote uses: the owner's tier when known, else Standard. */
export function feeFor(s: FeeSchedule, tier: LighterTier | null | undefined): LighterFeeRow & { tier: LighterTier; tierSource: TierSource } {
  const t = tier ?? "standard";
  return { ...s.tiers[t], tier: t, tierSource: s.tierSource };
}

/** Warnings a quote carries for this venue and order style. RH Standard makers wait 200 ms (post-only matters). */
export function latencyWarnings(venue: LighterVenue, tier: LighterTier, tif: "ioc" | "gtc" | "alo"): string[] {
  const row = LIGHTER_FEES[venue][tier];
  const out: string[] = [];
  if (tif === "alo" && row.makerLatencyMs > 0) out.push(`maker orders on ${venue} ${tier} wait ${row.makerLatencyMs} ms before they rest`);
  return out;
}

export function tierFromName(name: unknown): LighterTier | null {
  if (typeof name !== "string") return null;
  const n = name.toLowerCase();
  if (n === "standard") return "standard";
  if (n === "plus") return "plus";
  if (n.startsWith("premium")) return "premium";
  return null;
}
