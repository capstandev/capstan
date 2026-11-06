// Scanner fixtures: CR:ETH on Hyperliquid core (USDC, 1 h settle), Lighter mainnet (USDC, 1 h), Lighter-RH (USDG, 1 h),
// Aster (USDT, 8 h) and Variational (data only), with books and funding snapshots on one fixed clock.
import { memoryMarketDataCache, type MarketDataCache } from "@capstan/core";
import type { DepegReader, QuoteAdapter, QuoteMarket } from "@capstan/quote";
import type { CanonicalAsset, FundingSnapshot, OrderBook, VenueId } from "@capstan/schema";
import type { EquivalenceRow, FundingReader, ScanDeps, SpreadCatalog } from "../../src";

export const NOW = new Date("2026-11-01T12:00:30.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

export function market(id: string, venue: VenueId, o: Partial<QuoteMarket> = {}): QuoteMarket {
  return {
    id,
    venue,
    dex: null,
    venueSymbol: id.split(":")[2]!,
    marketType: "perp",
    canonicalAsset: "CR:ETH",
    collateralAsset: "USDC",
    tickSize: "0.1",
    lotSize: "0.001",
    minNotional: null,
    maxLeverage: 20,
    marginModes: ["cross", "isolated"],
    fundingIntervalS: 3600,
    fundingSettleIntervalS: 3600,
    sessionHours: null,
    oiCapUsd: null,
    builderFeeUnit: null,
    status: "active",
    executable: true,
    dataFreshness: "live",
    updatedAt: NOW.toISOString(),
    ...o,
  };
}

export const M = {
  hl: market("hyperliquid:-:ETH", "hyperliquid", { builderFeeUnit: "tenths_bp", lotSize: "0.0001" }),
  lt: market("lighter-mainnet:-:ETH", "lighter-mainnet", { tickSize: "0.01", lotSize: "0.0001", maintenanceMarginFraction: "0.03" } as Partial<QuoteMarket>),
  rh: market("lighter-rh:-:ETH", "lighter-rh", { collateralAsset: "USDG", tickSize: "0.01", lotSize: "0.0001", maintenanceMarginFraction: "0.03" } as Partial<QuoteMarket>),
  aster: market("aster:-:ETHUSDT", "aster", { collateralAsset: "USDT", fundingIntervalS: 28800, fundingSettleIntervalS: 28800, builderFeeUnit: "decimal_rate" }),
  var: market("variational:-:ETH", "variational", { executable: false, dataFreshness: "delayed" }),
};

/** A book around `mid` with `levels` levels of `sz` each, 0.5 apart. */
export function book(id: string, mid: number, sz = "5", levels = 20): OrderBook {
  const bids: [string, string][] = [];
  const asks: [string, string][] = [];
  for (let i = 0; i < levels; i++) {
    bids.push([(mid - 0.5 - i * 0.5).toFixed(2), sz]);
    asks.push([(mid + 0.5 + i * 0.5).toFixed(2), sz]);
  }
  return { marketId: id, bids, asks, asOf: iso(NOW.getTime() - 200) };
}

export function funding(id: string, ratePerInterval: string, intervalS: number, next?: string): FundingSnapshot {
  return { marketId: id, ratePerInterval, intervalS, ratePerHour: "0", rateAnnualised: "0", predictedNext: null, nextSettlementAt: next ?? iso(NOW.getTime() + 30 * 60_000), capPerHour: null, source: "venue", asOf: iso(NOW.getTime() - 1000) };
}

const caps = (venue: VenueId, exec: boolean) => ({ venue, execution: exec, keyType: exec ? ("secp256k1" as const) : null, delegation: exec ? ("agent" as const) : ("none" as const), canWithdraw: false as const, builderFee: null, collateral: ["USDC"], directSubmitSupported: exec, publicAccountReads: exec });

export interface Setup {
  deps: ScanDeps;
  eqs: EquivalenceRow[];
  books: Map<string, OrderBook>;
  fund: Map<string, FundingSnapshot>;
  markets: QuoteMarket[];
  alerts: unknown[];
  cache: MarketDataCache;
}

export function setup(o: { eqs?: EquivalenceRow[]; markets?: QuoteMarket[]; fund?: [string, FundingSnapshot][]; usdgBps?: number | null; eqAllowed?: boolean } = {}): Setup {
  const markets = o.markets ?? Object.values(M);
  const books = new Map(markets.map((m) => [m.id, book(m.id, m.venue === "aster" ? 2001 : 2000, m.venue === "lighter-mainnet" ? "2" : "5")]));
  const fund = new Map<string, FundingSnapshot>(
    o.fund ?? [
      [M.hl.id, funding(M.hl.id, "0.0001", 3600)], // 1.0 bp/h
      [M.lt.id, funding(M.lt.id, "0.00002", 3600)], // 0.2 bp/h
      [M.rh.id, funding(M.rh.id, "0.00005", 3600)], // 0.5 bp/h
      [M.aster.id, funding(M.aster.id, "0.0004", 28800, iso(NOW.getTime() + 4 * 3600_000))], // 0.5 bp/h at 8 h
      [M.var.id, funding(M.var.id, "0.004", 3600)], // the biggest rate, data only
    ],
  );
  const cache = memoryMarketDataCache();
  const getBook = async (id: string) => books.get(id) ?? null;
  const getFunding = async (id: string) => fund.get(id) ?? null;
  (cache as unknown as { getBook: typeof getBook }).getBook = getBook;
  const adapters = new Map<VenueId, QuoteAdapter>();
  for (const v of ["hyperliquid", "lighter-mainnet", "lighter-rh", "aster"] as VenueId[]) adapters.set(v, { caps: caps(v, true), getBook: async (id: string) => (await getBook(id))!, getFunding: async (id: string) => (await getFunding(id))! });
  adapters.set("variational", { caps: caps("variational", false), getBook, getFunding: async (id: string) => (await getFunding(id))! });
  const usdg = o.usdgBps === undefined ? 3 : o.usdgBps;
  const depeg: DepegReader = {
    usdgUsdcBps: async () => (usdg === null ? null : { bps: usdg, asOf: NOW.getTime() - 1000, source: "twap" } as never),
    usdtUsdcBps: async () => ({ bps: 1, asOf: NOW.getTime() - 1000, source: "twap" }) as never,
  };
  const eqs = o.eqs ?? [{ id: "eq-eth", canonicalAsset: "CR:ETH", marketIds: markets.map((m) => m.id), status: "approved", notes: "reviewed\noverride: USDG and USDT legs reviewed" }];
  const catalog: SpreadCatalog = {
    marketsByIds: async (ids) => ids.map((id) => markets.find((m) => m.id === id)).filter((m): m is QuoteMarket => !!m),
    equivalences: async (asset?: CanonicalAsset) => eqs.filter((e) => !asset || e.canonicalAsset === asset),
  };
  const fr: FundingReader = { get: async (id) => fund.get(id) ?? null };
  const alerts: unknown[] = [];
  const deps: ScanDeps = { catalog, quote: { adapters, cache, depeg }, funding: fr, now: () => NOW, eqExecutionAllowed: o.eqAllowed ?? false, alert: (x) => void alerts.push(x) };
  return { deps, eqs, books, fund, markets, alerts, cache };
}

export const REQ = { sizeUsd: "2000", leverage: 5 };
