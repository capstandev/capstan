// Spread scanner (spec 7.5 step 1, E4): ranks candidate pairs for funding-rate spread trades (at-risk). Only approved
// equivalences are read. Data-only venues (Variational, Arcus) are never an executable leg; they show as reference
// columns only. Funding is compared per hour (normalise from the funding forecaster), so a 1 h venue and an 8 h venue
// compare fairly. The higher-funding leg is the short, the lower the long; leg A is the less liquid leg (executed first).
// Each leg keeps its own collateral and its own estimated liquidation price at the requested leverage: nothing nets the
// legs' margin and collateral is never converted (a USDG against USDC row carries the depeg flag from the quote engine).
// The contract-spec diff is re-checked at scan time: a pair whose markets changed since approval is dropped and alerted.
import { contractSpecDiff } from "@capstan/catalog";
import { normalise, nextSettlements, routeQuote, type CatalogReader, type EngineLeg, type QuoteDeps, type QuoteFlag, type QuoteMarket } from "@capstan/quote";
import { Dec, SPREAD_RISK_LABEL, type CanonicalAsset, type FundingSnapshot, type OrderBook, type VenueId } from "@capstan/schema";
import { breakevenHours } from "./breakeven";
import { roundTripCostBps } from "./cost";

export const OBSERVED_NOTE = "Observed, changes hourly." as const;
export const DATA_ONLY: readonly VenueId[] = ["variational", "arcus"];
export const DEPTH_BAND_BPS = 10;

export interface ScanLeg {
  marketId: string;
  venue: VenueId;
  side: "buy" | "sell";
  ratePerHour: string;
  collateralAsset: string;
  estLiqPx: string | null;
  depthUsdAt10bps: string;
}

export interface ScanReference {
  marketId: string;
  venue: VenueId;
  ratePerHour: string | null;
  dataFreshness: "live" | "delayed";
}

export interface ScanRow {
  equivalenceId: string;
  canonicalAsset: CanonicalAsset;
  legA: ScanLeg;
  legB: ScanLeg;
  fundingDiffPerHourBps: number;
  roundTripCostBps: number;
  breakevenHours: number | null;
  nextSettlements: { venue: VenueId; at: string }[];
  riskLabel: typeof SPREAD_RISK_LABEL;
  observedNote: typeof OBSERVED_NOTE;
  flags: QuoteFlag[]; // DEPEG_FLAG / DEPEG_UNKNOWN when the legs' collateral differs
  references: ScanReference[]; // data-only venues, never executable
}

export interface EquivalenceRow {
  id: string;
  canonicalAsset: string;
  marketIds: string[];
  status: string; // proposed | approved | rejected
  notes: string | null;
}

/** The catalog the scanner reads: every equivalence (it keeps only approved ones itself) and markets by id. */
export interface SpreadCatalog extends Pick<CatalogReader, "marketsByIds"> {
  equivalences(asset?: CanonicalAsset): Promise<EquivalenceRow[]>;
}

export interface FundingReader {
  get(marketId: string): Promise<FundingSnapshot | null>;
}

export interface ScanRequest {
  asset?: CanonicalAsset;
  /** Keep rows that break even within this many hours of holding (null breakevens never pass). */
  minBreakevenHours?: number;
  /** Size per leg: USD notional (the scan) or base units (the planner). Exactly one. */
  sizeUsd?: string;
  sizeBase?: string;
  leverage: number;
  /** Planner filters: one equivalence, and optionally the exact two markets. */
  equivalenceId?: string;
  marketIds?: string[];
}

export interface ScanDeps {
  catalog: SpreadCatalog;
  quote: Omit<QuoteDeps, "now" | "catalog">;
  funding: FundingReader;
  now: () => Date;
  /** Legal flag EQ_EXECUTION_ALLOWED: equity-class pairs stay out while it is off. */
  eqExecutionAllowed?: boolean;
  /** Ops alert for a pair dropped because a market changed since approval. */
  alert?: (detail: { equivalenceId: string; a: string; b: string; fields: string[] }) => Promise<void> | void;
}

const S = 18;
const d = (x: string) => Dec.parse(x, S, "half_even");

/** Notional on the taken side within 10 bps of the mid: asks for a buy, bids for a sell. */
export function depthUsdAt(book: OrderBook | null, side: "buy" | "sell", bandBps = DEPTH_BAND_BPS): string {
  if (!book || !book.bids.length || !book.asks.length) return "0";
  const mid = Dec.div(Dec.add(d(book.bids[0]![0]), d(book.asks[0]![0])), Dec.parse("2", 0), S, "half_even");
  const band = Dec.div(Dec.mul(mid, Dec.parse(String(bandBps), 0), S), Dec.parse("10000", 0), S, "half_even");
  const lim = side === "buy" ? Dec.add(mid, band) : Dec.sub(mid, band);
  let total = Dec.parse("0", S);
  for (const [px, sz] of side === "buy" ? book.asks : book.bids) {
    const p = d(px);
    if (side === "buy" ? Dec.cmp(p, lim) > 0 : Dec.cmp(p, lim) < 0) break;
    total = Dec.add(total, Dec.mul(p, d(sz), S));
  }
  return Dec.toString(Dec.rescale(total, 2, "down"));
}

const isEquityClass = (a: string) => !a.startsWith("CR:");
/** R2: a market may be a spread leg only on an executing venue; Variational and Arcus are never legs, whatever the row says. */
export const executableLeg = (m: QuoteMarket) => !DATA_ONLY.includes(m.venue) && m.marketType === "perp" && m.executable && m.status === "active";

/** Blocking contract differences now present between two markets that the approval did not cover. */
export function untoleratedDiffs(a: QuoteMarket, b: QuoteMarket, approvalNotes: string | null): string[] {
  const overridden = (approvalNotes ?? "").includes("\noverride:");
  return contractSpecDiff(a, b)
    .filter((x) => x.blocking)
    .map((x) => x.field)
    .filter((f) => !(overridden && f === "collateralAsset")); // a reviewed USDG vs USDC pair: carried with the depeg flag
}

function perHour(f: FundingSnapshot): string {
  return normalise(f.ratePerInterval, f.intervalS).ratePerHour;
}

function bpsPerHour(x: Dec): number {
  return Number(Dec.toString(Dec.rescale(Dec.mul(x, Dec.parse("10000", 0), S), 4, "half_even")));
}

export async function scan(req: ScanRequest, deps: ScanDeps): Promise<ScanRow[]> {
  const now = deps.now();
  if ((req.sizeUsd === undefined) === (req.sizeBase === undefined)) throw new RangeError("scan: give exactly one of sizeUsd or sizeBase");
  const eqs = (await deps.catalog.equivalences(req.asset)).filter((e) => e.status === "approved" && (!req.asset || e.canonicalAsset === req.asset) && (!req.equivalenceId || e.id === req.equivalenceId));
  const rows: ScanRow[] = [];
  for (const e of eqs) {
    const asset = e.canonicalAsset as CanonicalAsset;
    if (isEquityClass(asset) && !deps.eqExecutionAllowed) continue;
    const markets = await deps.catalog.marketsByIds(e.marketIds);
    const legs = markets.filter(executableLeg).filter((m) => !req.marketIds || req.marketIds.includes(m.id));
    if (legs.length < 2) continue;
    const funding = new Map<string, FundingSnapshot>();
    for (const m of markets) {
      const f = await deps.funding.get(m.id).catch(() => null);
      if (f) funding.set(m.id, f);
    }
    const references: ScanReference[] = markets.filter((m) => DATA_ONLY.includes(m.venue)).map((m) => ({ marketId: m.id, venue: m.venue, ratePerHour: funding.has(m.id) ? perHour(funding.get(m.id)!) : null, dataFreshness: m.dataFreshness }));
    // one quote per side over every executable leg: open and close prices for any pair
    const qd: QuoteDeps = { ...deps.quote, catalog: { marketsByIds: async (ids) => legs.filter((m) => ids.includes(m.id)), marketsForAsset: async () => legs }, now: () => now.getTime() };
    const base = { marketIds: legs.map((m) => m.id), ...(req.sizeBase !== undefined ? { sizeBase: req.sizeBase } : { notionalUsd: req.sizeUsd! }), leverage: req.leverage, holdHours: 0, orderType: "market" as const };
    const buyQ = await routeQuote({ ...base, side: "buy" }, qd);
    const sellQ = await routeQuote({ ...base, side: "sell" }, qd);
    const leg = (q: typeof buyQ, id: string): EngineLeg | undefined => q.legs.find((l) => l.marketId === id);
    for (let i = 0; i < legs.length; i++)
      for (let j = i + 1; j < legs.length; j++) {
        const x = legs[i]!;
        const y = legs[j]!;
        const fx = funding.get(x.id);
        const fy = funding.get(y.id);
        if (!fx || !fy) continue;
        const bad = untoleratedDiffs(x, y, e.notes);
        if (bad.length) {
          await deps.alert?.({ equivalenceId: e.id, a: x.id, b: y.id, fields: bad });
          continue;
        }
        const rx = d(perHour(fx));
        const ry = d(perHour(fy));
        const [short, long, rShort, rLong] = Dec.cmp(rx, ry) >= 0 ? [x, y, rx, ry] : [y, x, ry, rx];
        const openShort = leg(sellQ, short.id);
        const openLong = leg(buyQ, long.id);
        const closeShort = leg(buyQ, short.id);
        const closeLong = leg(sellQ, long.id);
        if (![openShort, openLong, closeShort, closeLong].every((q) => q?.status === "ok")) continue;
        const depthShort = depthUsdAt(await deps.quote.cache.getBook(short.id), "sell");
        const depthLong = depthUsdAt(await deps.quote.cache.getBook(long.id), "buy");
        const mk = (m: QuoteMarket, side: "buy" | "sell", r: Dec, q: EngineLeg, depth: string): ScanLeg => ({ marketId: m.id, venue: m.venue, side, ratePerHour: Dec.toString(r), collateralAsset: m.collateralAsset, estLiqPx: q.estLiqPx, depthUsdAt10bps: depth });
        const sLeg = mk(short, "sell", rShort, openShort!, depthShort);
        const lLeg = mk(long, "buy", rLong, openLong!, depthLong);
        // leg A = the less liquid leg, executed first
        const shortFirst = Dec.cmp(d(depthShort), d(depthLong)) <= 0;
        const [legA, legB] = shortFirst ? [sLeg, lLeg] : [lLeg, sLeg];
        const [oA, oB, cA, cB] = shortFirst ? [openShort!, openLong!, closeShort!, closeLong!] : [openLong!, openShort!, closeLong!, closeShort!];
        const cost = roundTripCostBps(oA, oB, cA, cB);
        const diff = bpsPerHour(Dec.sub(rShort, rLong));
        const next = (m: QuoteMarket, f: FundingSnapshot) => ({ venue: m.venue, at: f.nextSettlementAt && Date.parse(f.nextSettlementAt) > now.getTime() ? f.nextSettlementAt : nextSettlements(m, now, 1)[0]! });
        rows.push({
          equivalenceId: e.id,
          canonicalAsset: asset,
          legA,
          legB,
          fundingDiffPerHourBps: diff,
          roundTripCostBps: cost,
          breakevenHours: breakevenHours(cost, diff),
          nextSettlements: [next(short, funding.get(short.id)!), next(long, funding.get(long.id)!)].sort((p, q) => (p.at < q.at ? -1 : p.at > q.at ? 1 : 0)),
          riskLabel: SPREAD_RISK_LABEL,
          observedNote: OBSERVED_NOTE,
          flags: [...new Set([...oA.flags, ...oB.flags, ...cA.flags, ...cB.flags])],
          references,
        });
      }
  }
  const out = req.minBreakevenHours === undefined ? rows : rows.filter((r) => r.breakevenHours !== null && r.breakevenHours <= req.minBreakevenHours!);
  return out.sort((a, b) => (a.breakevenHours ?? Number.POSITIVE_INFINITY) - (b.breakevenHours ?? Number.POSITIVE_INFINITY) || b.fundingDiffPerHourBps - a.fundingDiffPerHourBps || (a.equivalenceId < b.equivalenceId ? -1 : 1));
}
