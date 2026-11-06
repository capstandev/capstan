// Venue shapes -> canonical shapes (spec 3). Decimal strings end to end.
import { Dec, marketId, type AccountSnapshot, type FundingSnapshot, type Hex, type Market, type Order, type OrderBook, type Position, type VenueIdentity } from "@capstan/schema";
import { collateralFor, type HlAssetCtx, type HlDex, type HlUniverseEntry } from "./meta";
import { HL_MIN_NOTIONAL_USD, lotSize, pxDecimalsMax, tickSizeAt } from "./precision";

export const HOURS_PER_YEAR = 8760;
export const HL_FUNDING_INTERVAL_S = 28_800;
export const HL_FUNDING_SETTLE_S = 3_600;
export const HL_CORE_FUNDING_CAP_PER_HOUR = "0.04";

/** Market plus the precision inputs the order path needs. */
export interface HlMarket extends Market {
  szDecimals: number;
  pxDecimalsMax: number;
  assetId: number;
  dexIndex: number;
  onlyIsolated: boolean;
}

function decimals(s: string): number {
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/** Exact a * b for decimal strings, trailing zeros stripped. */
export function mulStr(a: string, b: string): string {
  const scale = Math.min(36, decimals(a) + decimals(b));
  return Dec.toString(Dec.mul(Dec.parse(a, decimals(a)), Dec.parse(b, decimals(b)), scale));
}

/** a / b rounded half-even to `scale` decimals. */
export function divStr(a: string, b: string, scale = 8): string {
  return Dec.toString(Dec.div(Dec.parse(a, decimals(a)), Dec.parse(b, decimals(b)), scale));
}

export function absStr(a: string): string {
  return a.startsWith("-") ? a.slice(1) : a;
}

export function isNeg(a: string): boolean {
  return a.startsWith("-") && !/^-0+(\.0+)?$/.test(a);
}

export function marginModesOf(e: HlUniverseEntry): ("cross" | "isolated")[] {
  if (e.onlyIsolated === true || e.marginMode === "strictIsolated" || e.marginMode === "noCross") return ["isolated"];
  return ["cross", "isolated"];
}

export interface ToMarketInput {
  entry: HlUniverseEntry;
  indexInMeta: number;
  dex: HlDex;
  collateralToken: number;
  ctx?: HlAssetCtx | null;
  oiCapUsd?: string | null;
  now: Date;
}

export function toMarket(i: ToMarketInput): HlMarket {
  const { entry, dex } = i;
  const coll = collateralFor(i.collateralToken);
  const dexName = dex.name;
  const isHip3 = dexName !== null;
  const assetIdValue = isHip3 ? 100_000 + dex.index * 10_000 + i.indexInMeta : i.indexInMeta;
  return {
    id: marketId("hyperliquid", dexName, entry.name),
    venue: "hyperliquid",
    dex: dexName,
    venueSymbol: entry.name,
    marketType: "perp",
    canonicalAsset: null,
    collateralAsset: coll.asset,
    tickSize: tickSizeAt(i.ctx?.markPx ?? null, entry.szDecimals),
    lotSize: lotSize(entry.szDecimals),
    minNotional: HL_MIN_NOTIONAL_USD,
    maxLeverage: Number.isFinite(entry.maxLeverage) ? entry.maxLeverage : null,
    marginModes: marginModesOf(entry),
    fundingIntervalS: HL_FUNDING_INTERVAL_S,
    fundingSettleIntervalS: HL_FUNDING_SETTLE_S,
    sessionHours: null,
    oiCapUsd: isHip3 ? (i.oiCapUsd ?? null) : null,
    builderFeeUnit: "tenths_bp",
    ...(entry.deployerFeeScale !== undefined ? { deployerFeeScale: entry.deployerFeeScale } : {}),
    ...(isHip3 ? { growthMode: entry.growthMode === "enabled" } : {}),
    venueIndex: i.indexInMeta,
    assetClassHint: null,
    contractMultiplier: "1",
    oracleSource: isHip3 ? `hip3-deployer:${(dex.oracleUpdater ?? dex.deployer ?? "unknown").toLowerCase()}` : "hyperliquid-validators",
    status: entry.isDelisted ? "delisted" : "active",
    // Executability comes only from the catalog review (todo 03) and, for HIP-3, todo 08. An unknown collateral
    // token can never execute.
    executable: false,
    dataFreshness: "live",
    updatedAt: i.now.toISOString(),
    szDecimals: entry.szDecimals,
    pxDecimalsMax: pxDecimalsMax(entry.szDecimals),
    assetId: assetIdValue,
    dexIndex: dex.index,
    onlyIsolated: marginModesOf(entry).length === 1,
    ...(coll.known ? {} : { collateralKnown: false }),
  } as HlMarket;
}

/** HL publishes funding per hour; interval 3600 s; annualised = perHour x 8760 (display only, observed). */
export function normalizeFunding(ratePerHour: string): Pick<FundingSnapshot, "ratePerInterval" | "intervalS" | "ratePerHour" | "rateAnnualised"> {
  if (!/^-?\d+(\.\d+)?$/.test(ratePerHour)) throw new Error(`hyperliquid: funding rate is not a decimal: ${ratePerHour}`);
  return { ratePerInterval: ratePerHour, intervalS: 3600, ratePerHour, rateAnnualised: mulStr(ratePerHour, String(HOURS_PER_YEAR)) };
}

export function nextHourIso(nowMs: number): string {
  return new Date(Math.floor(nowMs / 3_600_000) * 3_600_000 + 3_600_000).toISOString();
}

export interface HlL2Book {
  coin: string;
  time: number;
  levels: [{ px: string; sz: string; n: number }[], { px: string; sz: string; n: number }[]];
}

/** l2Book -> OrderBook. Prices and sizes stay strings; asOf is the venue's own time. */
export function toBook(id: string, raw: HlL2Book, depth?: number): OrderBook {
  if (!raw || !Array.isArray(raw.levels) || raw.levels.length !== 2) throw new Error("hyperliquid: l2Book has no levels");
  const lim = depth && depth > 0 ? depth : Number.POSITIVE_INFINITY;
  const side = (lv: { px: string; sz: string }[]) => lv.slice(0, lim).map((l) => [String(l.px), String(l.sz)] as [string, string]);
  return { marketId: id, bids: side(raw.levels[0]), asks: side(raw.levels[1]), asOf: new Date(Number(raw.time)).toISOString() };
}

export interface HlClearinghouseState {
  marginSummary: { accountValue: string; totalNtlPos: string; totalRawUsd: string; totalMarginUsed: string };
  crossMarginSummary: { accountValue: string; totalNtlPos: string; totalRawUsd: string; totalMarginUsed: string };
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: {
    type: string;
    position: {
      coin: string;
      szi: string;
      leverage: { type: "cross" | "isolated"; value: number; rawUsd?: string };
      entryPx: string;
      positionValue: string;
      unrealizedPnl: string;
      returnOnEquity?: string;
      liquidationPx: string | null;
      marginUsed: string;
      maxLeverage?: number;
      cumFunding?: unknown;
    };
  }[];
  time: number;
}

/** One dex account, exactly as the venue reports it. Never summed with another dex. */
export interface HlDexAccount {
  dex: string | null;
  collateralAsset: string;
  accountValue: string;
  withdrawable: string;
  marginUsed: string;
  maintenanceMarginUsed: string;
  positions: Position[];
  asOf: string;
}

export function toDexAccount(dex: string | null, collateralAsset: string, s: HlClearinghouseState): HlDexAccount {
  const asOf = new Date(Number(s.time)).toISOString();
  const positions: Position[] = [];
  for (const ap of s.assetPositions ?? []) {
    const p = ap.position;
    if (!p || !/^-?\d/.test(p.szi) || /^-?0+(\.0+)?$/.test(p.szi)) continue;
    const size = absStr(p.szi);
    positions.push({
      venue: "hyperliquid",
      marketId: marketId("hyperliquid", dex, p.coin),
      canonicalAsset: null,
      side: isNeg(p.szi) ? "short" : "long",
      size,
      entryPx: p.entryPx,
      markPx: divStr(p.positionValue, size, 8),
      notionalUsd: p.positionValue,
      leverage: p.leverage?.value ?? 0,
      marginMode: p.leverage?.type === "isolated" ? "isolated" : "cross",
      liqPx: p.liquidationPx ?? null,
      liqPxSource: "venue",
      marginRatio: null,
      unrealisedPnlUsd: p.unrealizedPnl,
      collateralAsset,
      asOf,
    });
  }
  return {
    dex,
    collateralAsset,
    accountValue: s.marginSummary.accountValue,
    withdrawable: s.withdrawable,
    marginUsed: s.marginSummary.totalMarginUsed,
    maintenanceMarginUsed: s.crossMaintenanceMarginUsed,
    positions,
    asOf,
  };
}

/**
 * AccountSnapshot for Hyperliquid. Each dex is its own margin account: `perDex` lists them separately and the top-level
 * equity and free collateral are the CORE dex's figures only (never a sum across dexes).
 */
export interface HlAccountSnapshot extends AccountSnapshot {
  perDex: HlDexAccount[];
}

export function toAccountSnapshot(identity: VenueIdentity, perDex: HlDexAccount[], nowIso: string): HlAccountSnapshot {
  const core = perDex.find((d) => d.dex === null);
  return {
    venue: "hyperliquid",
    identity,
    equityUsd: core?.accountValue ?? "0",
    freeCollateralUsd: core?.withdrawable ?? "0",
    positions: perDex.flatMap((d) => d.positions),
    asOf: core?.asOf ?? nowIso,
    perDex,
  };
}

export interface HlOpenOrder {
  coin: string;
  side: "B" | "A";
  limitPx: string;
  sz: string;
  oid: number | string;
  timestamp: number;
  origSz?: string;
  cloid?: Hex | null;
  reduceOnly?: boolean;
  orderType?: string;
  tif?: string | null;
  isTrigger?: boolean;
  triggerPx?: string;
}

export function toOrder(dex: string | null, o: HlOpenOrder): Order {
  const orig = o.origSz ?? o.sz;
  const filled = Dec.toString(Dec.sub(Dec.parse(orig, 12), Dec.parse(o.sz, 12)));
  return {
    venue: "hyperliquid",
    marketId: marketId("hyperliquid", dex, o.coin),
    venueOrderId: String(o.oid),
    ...(o.cloid ? { clientOrderId: o.cloid } : {}),
    side: o.side === "B" ? "buy" : "sell",
    size: orig,
    filled,
    px: o.limitPx ?? null,
    status: Dec.isZero(Dec.parse(filled, 12)) ? "open" : "partial",
    builderFeeBps: 0, // the venue does not report the builder per resting order
    createdAt: new Date(Number(o.timestamp)).toISOString(),
  };
}
