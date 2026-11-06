// Quote engine and best-venue routing (spec 9 quote-engine, spec 15 E1).
// Per leg: eligibility, executability, the 3 s staleness guard on T1 books, the venue's own order shape (QUOTE-1),
// the book walk at that shape, fees, sign-aware funding, a liquidation estimate where the margin model is known, then
// the cross-checks (Variational and Arcus marks) and the depeg grouping across collateral assets.
// Ranking: ok legs only, lowest totalCostBps first, ties to the deeper book. Data-only venues are listed with
// status 'data_only' and are never best. Nothing is ever summed or converted across venues or collateral assets.
//
// Safety inputs:
// | Input                 | Stale or bad value does                                   | Validity            |
// | T1 order book         | leg refused STALE_QUOTE                                   | 3 s                 |
// | Variational mark      | cross-check skipped (no divergence computed)              | 120 s               |
// | Arcus mark            | cross-check skipped                                       | 10 s                |
// | USDG/USDC, USDT/USDC  | cross-collateral legs flagged DEPEG_FLAG / DEPEG_UNKNOWN  | 5 min               |
// | Funding snapshot      | leg kept with fundingStaleMs; refused above 2 h           | 30 s cache, 2 h hard|
import { CapstanError, Dec, type CanonicalAsset, type EligibilityCode, type FundingSnapshot, type Hex, type OrderBook, type QuoteRequest, type VenueAdapter, type VenueId, type VenueQuote } from "@capstan/schema";
import type { MarketDataCache } from "@capstan/core";
import { ulid } from "@capstan/core";
import { bestPx, midPx, sideDepthNotional, walkBook } from "./book";
import { BPS, d, str, sumBps, toBps, ZERO } from "./dec";
import { DEPEG_FLAG_BPS, DEPEG_MAX_AGE_MS, type DepegReader, type DepegReading } from "./depeg";
import { baseFeeTier, defaultBuilderFeeBps, venueFeeBpsFor, type BuilderFeeFn, type FeeTier } from "./fees";
import { FUNDING_NOTE, fundingCostBps } from "./funding-cost";
import { quoteHash } from "./jcs";
import { estLiqPx, type QuoteMarket } from "./liq";
import { DEFAULT_MARKET_SLIPPAGE_BPS, DEFAULT_SHAPERS, type LegShaper } from "./shape";

export const STALE_MS = { t1: 3000, variationalCrossCheck: 120000 } as const;
export const ARCUS_CROSS_CHECK_MS = 10_000;
export const MARK_DIVERGENCE_BPS = 50;
export const FUNDING_HARD_STALE_MS = 2 * 3600_000;
export const REFUSED_REGION_REASON = "not available in your region" as const;

/** Structural read-only adapter (Variational, Arcus): see @capstan/adapter-variational and @capstan/adapter-arcus. */
export interface ReadOnlyAdapterLike {
  readonly caps: VenueAdapter["caps"];
  getBook(marketId: string): Promise<OrderBook | null>;
  getFunding(marketId: string): Promise<FundingSnapshot>;
  getQuoteBuckets?(marketId: string): Promise<{ size: "1k" | "100k" | "1m"; bid: string; ask: string; asOf: string }[]>;
  getMark?(marketId: string): Promise<{ mark: string; asOf: string } | null>;
}

/** The slice of a T1 VenueAdapter the engine reads (keyless market data only). */
export type T1QuoteAdapter = Pick<VenueAdapter, "caps" | "getBook" | "getFunding">;
export type QuoteAdapter = T1QuoteAdapter | ReadOnlyAdapterLike;

export interface EligibilityDecision {
  allowed: boolean;
  code?: EligibilityCode;
  decisionId?: string;
}

export interface CatalogReader {
  /** Every market mapped to the asset, data-only venues included (approved equivalences only). */
  marketsForAsset(asset: CanonicalAsset): Promise<QuoteMarket[]>;
  marketsByIds(ids: string[]): Promise<QuoteMarket[]>;
}

export interface QuoteDeps {
  adapters: Map<VenueId, QuoteAdapter>;
  cache: MarketDataCache;
  catalog: CatalogReader;
  eligibility?: (owner: Hex | undefined, venue: VenueId, marketId: string) => Promise<EligibilityDecision>;
  depeg: DepegReader;
  feeTier?: (owner: Hex | undefined, venue: VenueId) => Promise<FeeTier>;
  builderFeeBps?: BuilderFeeFn;
  /** Open interest in USD for an OI-capped market (HIP-3), when known. */
  openInterestUsd?: (marketId: string) => Promise<string | null>;
  /** Per-venue order shape (defaults call each adapter's own build rules where it exports them; see shape.ts). */
  shapers?: Partial<Record<VenueId, LegShaper>>;
  maxSlippageBps?: number;
  now: () => number;
}

export type RefusalCode = EligibilityCode | "STALE_QUOTE" | "LEVERAGE_ABOVE_MAX" | "VENUE_UNAVAILABLE";
export type QuoteFlag = "DEPEG_FLAG" | "DEPEG_UNKNOWN";

/** One leg as the engine returns it: the spec VenueQuote plus the shape, flags and cross-checks it computed. */
export interface EngineLeg extends Omit<VenueQuote, "refusal"> {
  refusal?: { code: RefusalCode; reason: string };
  sizeBase: string;
  limitPx: string | null;
  dataFreshness: "live" | "delayed";
  collateralGroup: string;
  flags: QuoteFlag[];
  fundingStaleMs: number | null;
  markDivergenceBps: number | null;
  markDivergenceSource: "variational" | "arcus" | null;
  canonicalAsset: CanonicalAsset | null;
}

export interface CollateralGroup {
  collateral: string;
  best: string | null;
  ranking: string[];
}

export interface EngineRouteQuote {
  requestId: string;
  legs: EngineLeg[];
  best: string | null;
  ranking: string[];
  receiptHint: string;
  collateralGroups: CollateralGroup[];
  depeg: { usdgUsdc: DepegReading | null; usdtUsdc: DepegReading | null };
  fundingNote: typeof FUNDING_NOTE;
  asOf: string;
}

/** Data-only by nature (no key type, no execution), not a T1 venue whose execution flag is merely off. */
const isReadOnly = (a: QuoteAdapter) => a.caps.execution === false && a.caps.keyType === null;

/** Collateral to its peg family: USDC, USDG, USDT (USDT0 too); anything else stands alone. */
export function pegOf(collateral: string): string {
  const c = collateral.toUpperCase();
  if (c === "USDT0") return "USDT";
  return c;
}

function emptyLeg(m: QuoteMarket, venue: VenueId, now: number): EngineLeg {
  return {
    marketId: m.id,
    venue,
    status: "refused",
    avgFillPx: "0",
    slippageBps: 0,
    venueFeeBps: 0,
    builderFeeBps: 0,
    fundingCostBps: 0,
    totalCostBps: 0,
    estLiqPx: null,
    collateralAsset: m.collateralAsset,
    asOf: new Date(now).toISOString(),
    staleMs: 0,
    sizeBase: "0",
    limitPx: null,
    dataFreshness: m.dataFreshness,
    collateralGroup: pegOf(m.collateralAsset),
    flags: [],
    fundingStaleMs: null,
    markDivergenceBps: null,
    markDivergenceSource: null,
    canonicalAsset: m.canonicalAsset,
  };
}

function refuse(leg: EngineLeg, code: RefusalCode, reason: string): EngineLeg {
  return { ...leg, status: "refused", refusal: { code, reason } };
}

/** Size for the request: sizeBase, or notional / best price on the side taken (the shaper floors it to the lot). */
function requestedSize(req: QuoteRequest, ref: string | null): string | null {
  if (req.sizeBase) return req.sizeBase;
  if (!req.notionalUsd || !ref || Dec.cmp(d(ref), ZERO) <= 0) return null;
  return str(Dec.div(d(req.notionalUsd), d(ref), 18, "down"));
}

async function fundingOf(deps: QuoteDeps, a: QuoteAdapter, id: string): Promise<FundingSnapshot | null> {
  const c = await deps.cache.getFunding(id);
  if (c) return c;
  try {
    return await a.getFunding(id);
  } catch {
    return null;
  }
}

async function bookOf(deps: QuoteDeps, a: QuoteAdapter, id: string): Promise<OrderBook | null> {
  const c = await deps.cache.getBook(id);
  if (c) return c;
  try {
    return (await a.getBook(id)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Age of a timestamp against now: the distance either way, so a future-dated input (clock skew, a bad venue clock)
 * is as stale as it is far off, never fresher than now. An unparsable time is infinitely old.
 */
export function ageMs(now: number, asOf: string): number {
  const t = Date.parse(asOf);
  return Number.isFinite(t) ? Math.abs(now - t) : Number.POSITIVE_INFINITY;
}

// The reference mark keeps the HL adapter's own rule (refPrice in adapter-hyperliquid orders.ts: now - asOf <= 3 s),
// so the quote's limit equals the build's (QUOTE-1). A future-dated mark only moves the reference, never the guard.
async function freshMark(deps: QuoteDeps, id: string, book: OrderBook | null, now: number): Promise<string | null> {
  const m = await deps.cache.getMark(id);
  if (m && now - Date.parse(m.asOf) <= STALE_MS.t1) return m.mark;
  void book;
  return null;
}

function applyCosts(leg: EngineLeg, fundingBps: number): EngineLeg {
  return { ...leg, fundingCostBps: fundingBps, totalCostBps: sumBps([leg.venueFeeBps, leg.builderFeeBps, leg.slippageBps, fundingBps]) };
}

async function quoteT1(req: QuoteRequest, m: QuoteMarket, a: T1QuoteAdapter, deps: QuoteDeps, now: number): Promise<{ leg: EngineLeg; depth: string }> {
  const venue = m.venue;
  let leg = emptyLeg(m, venue, now);
  if (req.owner && deps.eligibility) {
    const e = await deps.eligibility(req.owner, venue, m.id);
    if (!e.allowed) return { leg: refuse(leg, e.code ?? "GEO_REFUSED", REFUSED_REGION_REASON), depth: "0" };
  }
  if (!a.caps.execution) return { leg: refuse(leg, "MARKET_NOT_EXECUTABLE", "venue execution is off"), depth: "0" };
  if (!m.executable || m.marketType !== "perp" || m.status !== "active") return { leg: refuse(leg, "MARKET_NOT_EXECUTABLE", `market is ${m.status === "active" ? "not executable" : m.status}`), depth: "0" };
  if (m.maxLeverage !== null && req.leverage > m.maxLeverage) return { leg: refuse(leg, "LEVERAGE_ABOVE_MAX", `leverage is above the market maximum ${m.maxLeverage}`), depth: "0" };

  const book = await bookOf(deps, a, m.id);
  if (!book) return { leg: refuse(leg, "STALE_QUOTE", "no order book"), depth: "0" };
  // a book dated in the future (clock skew) counts that distance as age, so skew never makes a book look fresh
  const age = ageMs(now, book.asOf);
  leg = { ...leg, asOf: book.asOf, staleMs: age };
  if (!(age <= STALE_MS.t1)) return { leg: refuse(leg, "STALE_QUOTE", `order book is ${age} ms old`), depth: "0" };

  const best = bestPx(book, req.side);
  const size = requestedSize(req, best);
  if (!size || !best) return { leg: { ...leg, status: "insufficient_depth" }, depth: "0" };
  const shaper = deps.shapers?.[venue] ?? DEFAULT_SHAPERS[venue];
  let shape;
  try {
    shape = shaper({ market: m, book, mark: await freshMark(deps, m.id, book, now), side: req.side, orderType: req.orderType, sizeBase: size, ...(req.limitPx ? { limitPx: req.limitPx } : {}), maxSlippageBps: deps.maxSlippageBps ?? DEFAULT_MARKET_SLIPPAGE_BPS });
  } catch (e) {
    if (e instanceof CapstanError && e.code === "STALE_QUOTE") return { leg: refuse(leg, "STALE_QUOTE", e.message), depth: "0" };
    return { leg: { ...leg, status: "insufficient_depth" }, depth: "0" };
  }
  leg = { ...leg, sizeBase: shape.size, limitPx: shape.limitPx };

  const tier = await (deps.feeTier ?? baseFeeTier)(req.owner, venue);
  const venueFeeBps = venueFeeBpsFor(tier, m);
  const builderFeeBps = await (deps.builderFeeBps ?? defaultBuilderFeeBps())(req.owner, venue, m);
  leg = { ...leg, venueFeeBps, builderFeeBps };

  const w = walkBook(book, req.side, shape.size, shape.limitPx);
  const depth = sideDepthNotional(book, req.side);
  if ("insufficient" in w) return { leg: { ...leg, status: "insufficient_depth" }, depth };
  leg = { ...leg, avgFillPx: w.avgPx, slippageBps: w.slippageBps };

  // OI cap (HIP-3): the fill must fit under the cap with the open interest already there
  if (m.oiCapUsd) {
    const notional = Dec.mul(d(shape.size), d(w.avgPx), 18);
    const oi = deps.openInterestUsd ? await deps.openInterestUsd(m.id) : null;
    if (Dec.cmp(Dec.add(notional, oi ? d(oi) : ZERO), d(m.oiCapUsd)) > 0) return { leg: { ...leg, status: "insufficient_depth" }, depth };
  }

  const f = await fundingOf(deps, a, m.id);
  let fundingBps = 0;
  if (req.holdHours > 0) {
    if (!f) return { leg: refuse(leg, "STALE_QUOTE", "no funding snapshot"), depth };
    const fAge = ageMs(now, f.asOf);
    leg = { ...leg, fundingStaleMs: fAge };
    if (!(fAge <= FUNDING_HARD_STALE_MS)) return { leg: refuse(leg, "STALE_QUOTE", `funding is ${Math.round(fAge / 60_000)} minutes old`), depth };
    fundingBps = fundingCostBps(f.ratePerHour, req.holdHours, req.side);
  } else if (f) {
    leg = { ...leg, fundingStaleMs: ageMs(now, f.asOf) };
  }
  leg = applyCosts({ ...leg, status: "ok", estLiqPx: estLiqPx(venue, m, w.avgPx, req.leverage, req.side) }, fundingBps);
  return { leg, depth };
}

/** Variational bucket for a notional: up to 1k, up to 100k, else 1m when published. */
export function bucketFor(notional: number, sizes: string[]): "1k" | "100k" | "1m" | null {
  if (notional <= 1_000 && sizes.includes("1k")) return "1k";
  if (notional <= 100_000 && sizes.includes("100k")) return "100k";
  if (sizes.includes("1m")) return "1m";
  return null;
}

async function quoteDataOnly(req: QuoteRequest, m: QuoteMarket, a: ReadOnlyAdapterLike, deps: QuoteDeps, now: number): Promise<{ leg: EngineLeg; depth: string }> {
  const venue = m.venue;
  let leg: EngineLeg = { ...emptyLeg(m, venue, now), status: "data_only" };
  const tier = await (deps.feeTier ?? baseFeeTier)(req.owner, venue);
  leg = { ...leg, venueFeeBps: venueFeeBpsFor(tier, m), builderFeeBps: 0 };
  const book = await bookOf(deps, a, m.id);
  let depth = "0";
  if (book) {
    const age = ageMs(now, book.asOf);
    leg = { ...leg, asOf: book.asOf, staleMs: age };
    const size = requestedSize(req, bestPx(book, req.side));
    if (size) {
      const w = walkBook(book, req.side, size, req.orderType === "limit" ? req.limitPx : undefined);
      depth = sideDepthNotional(book, req.side);
      if (!("insufficient" in w)) leg = { ...leg, sizeBase: w.filled, avgFillPx: w.avgPx, slippageBps: w.slippageBps };
    }
  } else if (a.getQuoteBuckets) {
    // Variational: size buckets only. The leg shows the bucket price and the data's real age.
    const buckets = await a.getQuoteBuckets(m.id).catch(() => []);
    const mark = a.getMark ? await a.getMark(m.id).catch(() => null) : null;
    const ref = mark?.mark ?? null;
    const size = requestedSize(req, ref);
    if (buckets.length && size && ref) {
      const notional = Number(str(Dec.mul(d(size), d(ref), 2)));
      const b = buckets.find((x) => x.size === bucketFor(notional, buckets.map((y) => y.size)));
      if (b) {
        const px = req.side === "buy" ? b.ask : b.bid;
        const worse = req.side === "buy" ? Dec.sub(d(px), d(ref)) : Dec.sub(d(ref), d(px));
        leg = { ...leg, sizeBase: size, avgFillPx: px, slippageBps: toBps(Dec.div(Dec.mul(worse, BPS, 18), d(ref), 4, "half_even")), asOf: b.asOf, staleMs: ageMs(now, b.asOf) };
      }
    }
  }
  const f = await fundingOf(deps, a, m.id);
  let fundingBps = 0;
  if (f) {
    leg = { ...leg, fundingStaleMs: ageMs(now, f.asOf) };
    fundingBps = fundingCostBps(f.ratePerHour, req.holdHours, req.side);
  }
  return { leg: applyCosts(leg, fundingBps), depth };
}

/** T1 mark against the data-only feeds of the same canonical asset (R4, R15). Sets the largest flagged divergence. */
async function crossCheck(leg: EngineLeg, book: OrderBook | null, refs: QuoteMarket[], deps: QuoteDeps, now: number): Promise<EngineLeg> {
  const own = (await deps.cache.getMark(leg.marketId))?.mark ?? (book ? midPx(book) : null);
  if (!own) return leg;
  let out = leg;
  for (const r of refs) {
    const a = deps.adapters.get(r.venue);
    const limit = r.venue === "variational" ? STALE_MS.variationalCrossCheck : r.venue === "arcus" ? ARCUS_CROSS_CHECK_MS : 0;
    if (!limit) continue;
    const mk = (await deps.cache.getMark(r.id)) ?? (a && "getMark" in a && a.getMark ? await a.getMark(r.id).catch(() => null) : null);
    if (!mk) continue;
    const age = now - Date.parse(mk.asOf);
    if (!(age >= 0 && age < limit)) continue; // too old for a cross-check: warn-only input, nothing computed
    const ref = d(mk.mark);
    if (Dec.cmp(ref, ZERO) <= 0) continue;
    const bps = toBps(Dec.div(Dec.mul(Dec.abs(Dec.sub(d(own), ref)), BPS, 18), ref, 4, "half_even"));
    if (bps > MARK_DIVERGENCE_BPS && (out.markDivergenceBps === null || bps > out.markDivergenceBps)) out = { ...out, markDivergenceBps: bps, markDivergenceSource: r.venue as "variational" | "arcus" };
  }
  return out;
}

function readingBps(r: DepegReading | null, now: number): number | null {
  if (!r) return null;
  if (!(Math.abs(now - r.asOf) <= DEPEG_MAX_AGE_MS)) return null; // a future-dated reading is not fresh either
  return r.bps;
}

/**
 * Collateral clusters (R5, R6). USDC is the base. A peg family joins the USDC cluster only while its reading is fresh
 * (5 min) and within 25 bps; otherwise it ranks on its own and every leg in that cross-collateral comparison carries
 * DEPEG_FLAG (reading too far) or DEPEG_UNKNOWN (no fresh reading). Unmonitored families are always unknown.
 */
export function clusterOf(legs: EngineLeg[], usdg: DepegReading | null, usdt: DepegReading | null, now: number): { clusterOf: Map<string, string>; flags: Map<string, QuoteFlag> } {
  const families = [...new Set(legs.map((l) => l.collateralGroup))];
  const reading: Record<string, number | null> = { USDC: 0, USDG: readingBps(usdg, now), USDT: readingBps(usdt, now) };
  const clusterOfFamily = new Map<string, string>();
  const flagOfFamily = new Map<string, QuoteFlag>();
  for (const f of families) {
    const r = f in reading ? reading[f]! : null;
    if (r !== null && Math.abs(r) <= DEPEG_FLAG_BPS) clusterOfFamily.set(f, "USDC");
    else {
      clusterOfFamily.set(f, f);
      flagOfFamily.set(f, r === null ? "DEPEG_UNKNOWN" : "DEPEG_FLAG");
    }
  }
  return { clusterOf: clusterOfFamily, flags: flagOfFamily };
}

const STATUS_ORDER: Record<EngineLeg["status"], number> = { ok: 0, data_only: 1, refused: 2, insufficient_depth: 3 };

export async function routeQuote(req: QuoteRequest, deps: QuoteDeps): Promise<EngineRouteQuote> {
  const now = deps.now();
  if (!req.canonicalAsset && !req.marketIds?.length) throw new CapstanError("INVALID_INPUT", "canonicalAsset or marketIds is required");
  if (!req.sizeBase && !req.notionalUsd) throw new CapstanError("INVALID_INPUT", "sizeBase or notionalUsd is required");
  const markets = req.marketIds?.length ? await deps.catalog.marketsByIds(req.marketIds) : await deps.catalog.marketsForAsset(req.canonicalAsset!);
  // cross-check references: data-only markets of each canonical asset quoted
  const assets = [...new Set(markets.map((m) => m.canonicalAsset).filter((x): x is CanonicalAsset => x !== null))];
  const refsByAsset = new Map<string, QuoteMarket[]>();
  for (const asset of assets) refsByAsset.set(asset, (await deps.catalog.marketsForAsset(asset)).filter((m) => m.venue === "variational" || m.venue === "arcus"));

  const results: { leg: EngineLeg; depth: string }[] = [];
  for (const m of markets) {
    const a = deps.adapters.get(m.venue);
    if (!a) {
      results.push({ leg: refuse(emptyLeg(m, m.venue, now), "VENUE_UNAVAILABLE", "venue is not configured"), depth: "0" });
      continue;
    }
    if (isReadOnly(a) || m.venue === "variational" || m.venue === "arcus") {
      results.push(await quoteDataOnly(req, m, a as ReadOnlyAdapterLike, deps, now));
      continue;
    }
    const r = await quoteT1(req, m, a as T1QuoteAdapter, deps, now);
    if (r.leg.status === "ok" && m.canonicalAsset) {
      const book = await deps.cache.getBook(m.id);
      r.leg = await crossCheck(r.leg, book, refsByAsset.get(m.canonicalAsset) ?? [], deps, now);
    }
    results.push(r);
  }

  // depeg clusters: only matters when more than one family is being compared
  const usdg = await deps.depeg.usdgUsdcBps().catch(() => null);
  const usdt = await deps.depeg.usdtUsdcBps().catch(() => null);
  const comparable = results.filter((r) => r.leg.status === "ok" || r.leg.status === "data_only");
  const { clusterOf: cl, flags } = clusterOf(comparable.map((r) => r.leg), usdg, usdt, now);
  const clustersInPlay = new Set(comparable.map((r) => cl.get(r.leg.collateralGroup)!));
  if (clustersInPlay.size > 1) {
    const flagged = new Set<QuoteFlag>([...flags.entries()].filter(([fam]) => comparable.some((r) => r.leg.collateralGroup === fam)).map(([, f]) => f));
    for (const r of comparable) {
      const own = flags.get(r.leg.collateralGroup);
      const add = own ? [own] : [...flagged];
      r.leg = { ...r.leg, flags: [...new Set([...r.leg.flags, ...add])] };
    }
  }
  const clusterKey = (l: EngineLeg) => (l.status === "ok" || l.status === "data_only" ? (cl.get(l.collateralGroup) ?? l.collateralGroup) : l.collateralGroup);

  const okSort = (x: { leg: EngineLeg; depth: string }, y: { leg: EngineLeg; depth: string }) => x.leg.totalCostBps - y.leg.totalCostBps || Dec.cmp(d(y.depth), d(x.depth)) || (x.leg.marketId < y.leg.marketId ? -1 : 1);
  const groupsMap = new Map<string, { leg: EngineLeg; depth: string }[]>();
  for (const r of results) {
    const k = clusterKey(r.leg);
    groupsMap.set(k, [...(groupsMap.get(k) ?? []), r]);
  }
  const groups: CollateralGroup[] = [];
  for (const [k, rs] of groupsMap) {
    const ok = rs.filter((r) => r.leg.status === "ok").sort(okSort);
    const rest = rs.filter((r) => r.leg.status !== "ok").sort((x, y) => STATUS_ORDER[x.leg.status] - STATUS_ORDER[y.leg.status] || (x.leg.status === "data_only" ? okSort(x, y) : x.leg.marketId < y.leg.marketId ? -1 : 1));
    groups.push({ collateral: k, best: ok[0]?.leg.marketId ?? null, ranking: [...ok, ...rest].map((r) => r.leg.marketId) });
  }
  const costOfBest = (g: CollateralGroup) => (g.best ? results.find((r) => r.leg.marketId === g.best)!.leg.totalCostBps : Number.POSITIVE_INFINITY);
  groups.sort((a, b) => costOfBest(a) - costOfBest(b) || (a.collateral < b.collateral ? -1 : 1));

  // one cluster: plain ranking. Several: each cluster ranked on its own, clusters in order of their best leg; the
  // overall ranking still lists every ok leg before any data_only, refused or thin leg.
  const allOk = groups.flatMap((g) => g.ranking.filter((id) => results.find((r) => r.leg.marketId === id)!.leg.status === "ok"));
  const others = results
    .filter((r) => r.leg.status !== "ok")
    .sort((x, y) => STATUS_ORDER[x.leg.status] - STATUS_ORDER[y.leg.status] || (x.leg.status === "data_only" ? okSort(x, y) : x.leg.marketId < y.leg.marketId ? -1 : 1))
    .map((r) => r.leg.marketId);
  const ranking = [...allOk, ...others];
  const best = groups[0]?.best ?? null;

  const body: EngineRouteQuote = {
    requestId: ulid(), // an id on the real clock; the quote time is asOf
    legs: results.map((r) => r.leg),
    best,
    ranking,
    receiptHint: "",
    collateralGroups: groups,
    depeg: { usdgUsdc: usdg, usdtUsdc: usdt },
    fundingNote: FUNDING_NOTE,
    asOf: new Date(now).toISOString(),
  };
  // receiptHint = sha256(JCS(the quote with receiptHint "")); quote_snapshots stores the same hash
  return { ...body, receiptHint: quoteHash(body) };
}

export function totalCostBps(q: Pick<VenueQuote, "venueFeeBps" | "builderFeeBps" | "slippageBps" | "fundingCostBps">): number {
  return sumBps([q.venueFeeBps, q.builderFeeBps, q.slippageBps, q.fundingCostBps]);
}


