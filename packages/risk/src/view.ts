// Risk view (spec 3 RiskView, E3). Every venue account stays its own entry (perVenue), as the venue reports it: no
// field sums or nets collateral, equity or margin across venues (invariant 3). Exposure is notional only. Each
// position's liquidation distance is measured against its own venue's liquidation price, and stress judges each
// venue alone, so a long on one venue and a short on another can both be listed. Venue-reported values are copied
// unchanged (no unit multiplier is ever applied here). The banner is fixed text.
import { Dec, RISK_BANNER, type AccountSnapshot, type CanonicalAsset, type Hex, type Position, type RiskView, type VenueId, type VenueIdentity } from "@capstan/schema";
import type { CatalogReader } from "@capstan/quote";
import type { PendingAccount } from "./accounts";

export const BANNER = RISK_BANNER;
export const DEFAULT_SHOCKS_PCT = [-20, -10, -5, 5, 10, 20] as const;

const S = 18;
const d = (x: string) => Dec.parse(x, S, "half_even");
const ZERO = Dec.parse("0", S);
const HUNDRED = Dec.parse("100", 0);
const str = (x: Dec) => Dec.toString(x);
const isNum = (x: unknown): x is string => typeof x === "string" && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(x.trim());

export interface LadderRow {
  marketId: string;
  venue: VenueId;
  liqPx: string | null;
  distancePct: number | null; // |mark - liq| / mark x 100, null when liqPx is null
  liqPxSource: Position["liqPxSource"];
  markPx: string;
  side: Position["side"];
}

export interface UnmappedExposure {
  marketId: string;
  venue: VenueId;
  side: Position["side"];
  notionalUsd: string;
}

/** RiskView plus the parts the spec leaves open: pending venues and positions with no canonical asset. */
export interface CapstanRiskView extends RiskView {
  liquidationLadder: LadderRow[];
  pending: PendingAccount[];
  unmappedExposure: UnmappedExposure[];
}

/** Fill each position's canonical asset from the catalog (approved mappings only). Never changes venue values. */
export async function withCanonicalAssets(snaps: AccountSnapshot[], catalog: CatalogReader): Promise<AccountSnapshot[]> {
  const ids = [...new Set(snaps.flatMap((s) => s.positions.filter((p) => p.canonicalAsset === null).map((p) => p.marketId)))];
  if (!ids.length) return snaps;
  const ms = await catalog.marketsByIds(ids);
  const asset = new Map(ms.map((m) => [m.id, m.canonicalAsset]));
  const fill = (p: Position): Position => (p.canonicalAsset !== null ? p : { ...p, canonicalAsset: asset.get(p.marketId) ?? null });
  return snaps.map((s) => {
    const out = { ...s, positions: s.positions.map(fill) } as AccountSnapshot & { perDex?: { positions: Position[] }[] };
    if (Array.isArray(out.perDex)) out.perDex = out.perDex.map((x) => ({ ...x, positions: x.positions.map(fill) }));
    return out;
  });
}

const signedNotional = (p: Position): Dec => {
  const n = Dec.abs(d(p.notionalUsd));
  return p.side === "short" ? Dec.neg(n) : n;
};

export function exposureByAsset(snaps: AccountSnapshot[]): RiskView["exposureByAsset"] {
  const by = new Map<CanonicalAsset, { gross: Dec; net: Dec; legs: string[] }>();
  for (const s of snaps)
    for (const p of s.positions) {
      if (p.canonicalAsset === null || !isNum(p.notionalUsd)) continue;
      const e = by.get(p.canonicalAsset) ?? { gross: ZERO, net: ZERO, legs: [] };
      e.gross = Dec.add(e.gross, Dec.abs(d(p.notionalUsd)));
      e.net = Dec.add(e.net, signedNotional(p));
      e.legs.push(p.marketId);
      by.set(p.canonicalAsset, e);
    }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([canonicalAsset, e]) => ({ canonicalAsset, grossUsd: str(e.gross), netUsd: str(e.net), legs: e.legs }));
}

/** Positions with no canonical asset: listed on their own, never grouped with anything. */
export function unmappedExposure(snaps: AccountSnapshot[]): UnmappedExposure[] {
  return snaps.flatMap((s) => s.positions.filter((p) => p.canonicalAsset === null).map((p) => ({ marketId: p.marketId, venue: p.venue, side: p.side, notionalUsd: p.notionalUsd })));
}

/** |mark - liq| / mark as a percentage, 4 decimals; null when either is missing or the mark is not positive. */
export function distancePct(mark: string, liq: string | null): number | null {
  if (liq === null || !isNum(liq) || !isNum(mark)) return null;
  const m = d(mark);
  if (Dec.cmp(m, ZERO) <= 0) return null;
  const l = d(liq);
  if (Dec.cmp(l, ZERO) <= 0) return null; // venues report 0 for "no liquidation price"
  const pct = Dec.div(Dec.mul(Dec.abs(Dec.sub(m, l)), HUNDRED, S), m, 4, "half_even");
  return Number(str(pct));
}

export function liquidationLadder(snaps: AccountSnapshot[], marks: Map<string, string>): LadderRow[] {
  const rows: LadderRow[] = [];
  for (const s of snaps)
    for (const p of s.positions) {
      const mark = marks.get(p.marketId) ?? p.markPx;
      const dist = distancePct(mark, p.liqPx);
      rows.push({ marketId: p.marketId, venue: p.venue, liqPx: dist === null && (p.liqPx === null || !isNum(p.liqPx) || Dec.cmp(d(p.liqPx), ZERO) <= 0) ? null : p.liqPx, distancePct: dist, liqPxSource: p.liqPxSource, markPx: mark, side: p.side });
    }
  return rows.sort((a, b) => (a.distancePct ?? Number.POSITIVE_INFINITY) - (b.distancePct ?? Number.POSITIVE_INFINITY) || (a.marketId < b.marketId ? -1 : 1));
}

/** True when a mark move of shockPct takes the position across its own venue's liquidation price. */
export function crossesOwnLiq(p: Position, mark: string, shockPct: number): boolean {
  if (p.liqPx === null || !isNum(p.liqPx) || !isNum(mark)) return false;
  const liq = d(p.liqPx);
  if (Dec.cmp(liq, ZERO) <= 0) return false;
  const factor = Dec.add(Dec.parse("1", S), Dec.div(Dec.parse(String(shockPct), 6, "half_even"), HUNDRED, S, "half_even"));
  const shocked = Dec.mul(d(mark), factor, S);
  return p.side === "long" ? Dec.cmp(shocked, liq) <= 0 : Dec.cmp(shocked, liq) >= 0;
}

export function stress(snaps: AccountSnapshot[], shocksPct: readonly number[] = DEFAULT_SHOCKS_PCT, marks: Map<string, string> = new Map()): RiskView["stress"] {
  const assets = [...new Set(snaps.flatMap((s) => s.positions.map((p) => p.canonicalAsset)).filter((a): a is CanonicalAsset => a !== null))].sort();
  const out: RiskView["stress"] = [];
  for (const asset of assets)
    for (const shockPct of shocksPct) {
      const venues = new Set<VenueId>();
      for (const s of snaps)
        for (const p of s.positions) if (p.canonicalAsset === asset && crossesOwnLiq(p, marks.get(p.marketId) ?? p.markPx, shockPct)) venues.add(p.venue);
      out.push({ canonicalAsset: asset, shockPct, venuesLiquidated: [...venues].sort() });
    }
  return out;
}

export async function buildRiskView(
  owner: Hex | null,
  ids: VenueIdentity[],
  snaps: AccountSnapshot[],
  marks: Map<string, string>,
  catalog: CatalogReader,
  now: Date,
  opts: { pending?: PendingAccount[]; shocksPct?: readonly number[] } = {},
): Promise<CapstanRiskView> {
  const perVenue = await withCanonicalAssets(snaps, catalog);
  return {
    owner,
    addresses: ids,
    perVenue,
    exposureByAsset: exposureByAsset(perVenue),
    liquidationLadder: liquidationLadder(perVenue, marks),
    stress: stress(perVenue, opts.shocksPct ?? DEFAULT_SHOCKS_PCT, marks),
    banner: BANNER,
    asOf: now.toISOString(),
    pending: opts.pending ?? [],
    unmappedExposure: unmappedExposure(perVenue),
  };
}
