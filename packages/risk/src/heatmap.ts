// Liquidation heatmap for one canonical asset from public Hyperliquid and Lighter account samples the service already
// reads. Notional is bucketed by each position's own liquidation price, in 0.5% steps around the median mark, per
// venue. The output is built from scratch from numbers only: no address, account index or agent ref ever appears.
import { Dec, type CanonicalAsset, type VenueId } from "@capstan/schema";

export interface PublicPositionSample {
  venue: VenueId;
  marketId: string;
  liqPx: string | null;
  markPx: string;
  notionalUsd: string;
}

export const HEATMAP_VENUES: readonly VenueId[] = ["hyperliquid", "lighter-mainnet", "lighter-rh"];
export const HEATMAP_RANGE_PCT = 50;

const S = 18;
const d = (x: string) => Dec.parse(x, S, "half_even");
const ok = (x: unknown): x is string => typeof x === "string" && /^\d+(\.\d+)?$/.test(x);

export interface Heatmap {
  canonicalAsset: CanonicalAsset;
  referencePx: string | null;
  bucketPct: number;
  priceBuckets: string[]; // lower edge of each bucket
  notionalByVenue: Record<string, string[]>;
  samples: number;
}

export function liqHeatmap(asset: CanonicalAsset, positions: PublicPositionSample[], bucketPct = 0.5): Heatmap {
  const use = positions.filter((p) => HEATMAP_VENUES.includes(p.venue) && ok(p.markPx) && ok(p.notionalUsd) && p.liqPx !== null && ok(p.liqPx) && Number(p.liqPx) > 0 && Number(p.markPx) > 0);
  const empty: Heatmap = { canonicalAsset: asset, referencePx: null, bucketPct, priceBuckets: [], notionalByVenue: {}, samples: 0 };
  if (!use.length) return empty;
  const marks = use.map((p) => d(p.markPx)).sort((a, b) => Dec.cmp(a, b));
  const ref = marks[Math.floor((marks.length - 1) / 2)]!;
  const step = Dec.parse(String(bucketPct), 6, "half_even");
  const idxOf = (liq: Dec): number | null => {
    // percent offset of liq from ref, floored to the bucket
    const pct = Dec.div(Dec.mul(Dec.sub(liq, ref), Dec.parse("100", 0), S), ref, S, "half_even");
    if (Dec.cmp(Dec.abs(pct), Dec.parse(String(HEATMAP_RANGE_PCT), 0)) > 0) return null;
    return Number(Dec.toString(Dec.rescale(Dec.div(pct, step, 0, "down"), 0)));
  };
  const rows: { i: number; venue: VenueId; n: Dec }[] = [];
  for (const p of use) {
    const i = idxOf(d(p.liqPx!));
    if (i !== null) rows.push({ i, venue: p.venue, n: Dec.abs(d(p.notionalUsd)) });
  }
  if (!rows.length) return { ...empty, referencePx: Dec.toString(ref) };
  const lo = Math.min(...rows.map((r) => r.i));
  const hi = Math.max(...rows.map((r) => r.i));
  const priceBuckets: string[] = [];
  for (let i = lo; i <= hi; i++) {
    const edge = Dec.mul(ref, Dec.add(Dec.parse("1", S), Dec.div(Dec.mul(step, Dec.parse(String(i), 0), S), Dec.parse("100", 0), S, "half_even")), S);
    priceBuckets.push(Dec.toString(Dec.rescale(edge, 8, "half_even")));
  }
  const notionalByVenue: Record<string, string[]> = {};
  for (const v of [...new Set(rows.map((r) => r.venue))].sort()) {
    const cells = new Array<Dec>(hi - lo + 1).fill(Dec.parse("0", S));
    for (const r of rows) if (r.venue === v) cells[r.i - lo] = Dec.add(cells[r.i - lo]!, r.n);
    notionalByVenue[v] = cells.map((c) => Dec.toString(Dec.rescale(c, 2, "half_even"), { fixed: true }));
  }
  return { canonicalAsset: asset, referencePx: Dec.toString(ref), bucketPct, priceBuckets, notionalByVenue, samples: rows.length };
}

/** Samples from stored risk views: only the numbers, only HL and Lighter, only the asked asset. */
export function samplesFromViews(views: { perVenue: { venue: VenueId; positions: { canonicalAsset: string | null; marketId: string; liqPx: string | null; markPx: string; notionalUsd: string; venue: VenueId }[] }[] }[], asset: CanonicalAsset): PublicPositionSample[] {
  const out: PublicPositionSample[] = [];
  for (const v of views)
    for (const s of v.perVenue) {
      if (!HEATMAP_VENUES.includes(s.venue)) continue;
      for (const p of s.positions) if (p.canonicalAsset === asset) out.push({ venue: p.venue, marketId: p.marketId, liqPx: p.liqPx, markPx: p.markPx, notionalUsd: p.notionalUsd });
    }
  return out;
}
