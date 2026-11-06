// MarketSources built from the recorded venue fixtures (packages/venue-client/fixtures). Real sources come from the
// adapter lanes; these keep the catalog tests on real venue data. The parse is deliberately small.
import { marketId, type CanonicalClass, type Market, type VenueId } from "@capstan/schema";
import { loadFixture } from "@capstan/venue-client";
import type { MarketSource } from "../src/sync";

const NOW = "2026-11-06T00:00:00.000Z";
const pow = (d: number) => (d <= 0 ? "1" : `0.${"0".repeat(d - 1)}1`);

function base(venue: VenueId, dex: string | null, sym: string, o: Partial<Market>): Market {
  return {
    id: marketId(venue, dex, sym),
    venue,
    dex,
    venueSymbol: sym,
    marketType: "perp",
    canonicalAsset: null,
    collateralAsset: "USDC",
    tickSize: "0.01",
    lotSize: "0.01",
    minNotional: null,
    maxLeverage: null,
    marginModes: ["cross", "isolated"],
    fundingIntervalS: 3600,
    fundingSettleIntervalS: 3600,
    sessionHours: null,
    oiCapUsd: null,
    builderFeeUnit: null,
    status: "active",
    executable: false,
    dataFreshness: "live",
    updatedAt: NOW,
    contractMultiplier: "1",
    ...o,
  };
}

type HlAsset = { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean; onlyIsolated?: boolean; marginMode?: string; growthMode?: string; deployerFeeScale?: string };

function hlMarkets(universe: HlAsset[], dex: string | null): Market[] {
  return universe.map((u, i) =>
    base("hyperliquid", dex, u.name, {
      tickSize: pow(6 - u.szDecimals),
      lotSize: pow(u.szDecimals),
      maxLeverage: u.maxLeverage,
      marginModes: u.onlyIsolated || u.marginMode === "strictIsolated" || u.marginMode === "noCross" ? ["isolated"] : ["cross", "isolated"],
      fundingIntervalS: 28800,
      fundingSettleIntervalS: 3600,
      builderFeeUnit: "tenths_bp",
      status: u.isDelisted ? "delisted" : "active",
      venueIndex: i,
      growthMode: u.growthMode ? u.growthMode === "enabled" : undefined,
      deployerFeeScale: u.deployerFeeScale,
      oracleSource: dex ? `hip3:${dex}` : "hl",
    }),
  );
}

export function hyperliquidSource(opts: { drop?: string[]; dropDexes?: string[] } = {}): MarketSource {
  const core = loadFixture<{ universe: HlAsset[] }>("hyperliquid", "meta").universe;
  const byDex: Record<string, HlAsset[]> = {};
  for (const d of ["xyz", "io", "para"]) byDex[d] = loadFixture<[{ universe: HlAsset[] }, unknown[]]>("hyperliquid", `metaAndAssetCtxs_${d}`)[0].universe;
  const dexes = loadFixture<({ name: string } | null)[]>("hyperliquid", "perpDexs");
  return {
    venue: "hyperliquid",
    async listMarkets() {
      const all = [...hlMarkets(core, null), ...Object.entries(byDex).filter(([d]) => !opts.dropDexes?.includes(d)).flatMap(([d, u]) => hlMarkets(u, d))];
      return all.filter((m) => !opts.drop?.includes(m.id));
    },
    async listDexes() {
      return dexes
        .map((d, i) => (d ? { dex: d.name, index: i, liveMarkets: byDex[d.name]?.filter((u) => !u.isDelisted).length ?? 0 } : null))
        .filter((d): d is { dex: string; index: number; liveMarkets: number } => d !== null && !opts.dropDexes?.includes(d.dex));
    },
  };
}

export function lighterSource(cfg: "lighter-304" | "lighter-466324"): MarketSource {
  const venue: VenueId = cfg === "lighter-304" ? "lighter-mainnet" : "lighter-rh";
  const books = loadFixture<{ order_books: { symbol: string; market_id: number; market_type: string; status: string; supported_size_decimals: number; supported_price_decimals: number; min_quote_amount: string; multiplier?: string }[] }>(cfg, "orderBooks").order_books;
  return {
    venue,
    async listMarkets() {
      return books.map((b) =>
        base(venue, null, b.symbol, {
          marketType: b.market_type === "perp" ? "perp" : b.market_type === "spot" ? "spot" : "other",
          collateralAsset: cfg === "lighter-304" ? "USDC" : "USDG",
          tickSize: pow(b.supported_price_decimals),
          lotSize: pow(b.supported_size_decimals),
          minNotional: b.min_quote_amount,
          status: b.status === "active" ? "active" : "delisted",
          venueIndex: b.market_id,
          builderFeeUnit: "ppm",
          contractMultiplier: b.multiplier ? String(Number(b.multiplier)) : "1",
        }),
      );
    },
  };
}

export function asterSource(): MarketSource {
  type F = { filterType: string; tickSize?: string; stepSize?: string; notional?: string };
  const syms = loadFixture<{ symbols: { symbol: string; status: string; marginAsset: string; contractType: string; symbolType?: number; filters: F[] }[] }>("aster", "exchangeInfo").symbols;
  return {
    venue: "aster",
    async listMarkets() {
      return syms.map((s) =>
        base("aster", null, s.symbol, {
          marketType: s.contractType === "PERPETUAL" ? "perp" : "other",
          collateralAsset: s.marginAsset,
          tickSize: s.filters.find((f) => f.filterType === "PRICE_FILTER")?.tickSize ?? "0",
          lotSize: s.filters.find((f) => f.filterType === "LOT_SIZE")?.stepSize ?? "0",
          minNotional: s.filters.find((f) => f.filterType === "MIN_NOTIONAL")?.notional ?? null,
          fundingIntervalS: 28800,
          fundingSettleIntervalS: 28800,
          builderFeeUnit: "decimal_rate",
          status: s.status === "TRADING" ? "active" : s.status === "SETTLING" ? "delisted" : "unknown",
          assetClassHint: s.symbolType === 1 ? "EQ" : null,
        }),
      );
    },
  };
}

export function variationalSource(): MarketSource {
  const l = loadFixture<{ listings: { ticker: string; contract_type: string; funding: { interval_seconds: number } }[] }>("variational", "stats").listings;
  return {
    venue: "variational",
    async listMarkets() {
      return l.map((x) =>
        base("variational", null, x.ticker, {
          marketType: x.contract_type === "perpetual" ? "perp" : "other",
          tickSize: "0",
          lotSize: "0",
          fundingIntervalS: x.funding.interval_seconds,
          fundingSettleIntervalS: x.funding.interval_seconds,
          dataFreshness: "delayed",
        }),
      );
    },
  };
}

const ARCUS_CLASS: Record<string, CanonicalClass> = { CRYPTO: "CR", EQUITIES: "EQ", INDICES: "IX", COMMODITIES: "CM" };
export function arcusSource(): MarketSource {
  const ms = loadFixture<{ markets: { marketDisplayName: string; status: string; tickSize: string; stepSize: string; category: string; type: string; minOrderNotional?: string }[] }>("arcus", "markets").markets;
  return {
    venue: "arcus",
    async listMarkets() {
      return ms.map((m) =>
        base("arcus", null, m.marketDisplayName, {
          marketType: m.type === "PERPETUAL" ? "perp" : "other",
          collateralAsset: "USDG",
          tickSize: m.tickSize,
          lotSize: m.stepSize,
          minNotional: m.minOrderNotional ?? null,
          status: m.status === "ONLINE" ? "active" : "delisted",
          assetClassHint: ARCUS_CLASS[m.category] ?? null,
          oracleSource: "pyth",
        }),
      );
    },
  };
}

export function allFixtureSources(): MarketSource[] {
  return [hyperliquidSource(), lighterSource("lighter-304"), lighterSource("lighter-466324"), asterSource(), variationalSource(), arcusSource()];
}

/** A one-off source for hand-built cases. */
export function staticSource(venue: VenueId, markets: (Partial<Market> & { venueSymbol: string })[], dexes?: { dex: string; index: number; liveMarkets: number }[]): MarketSource {
  return {
    venue,
    async listMarkets() {
      return markets.map((m) => base(venue, m.dex ?? null, m.venueSymbol, m));
    },
    ...(dexes ? { listDexes: async () => dexes } : {}),
  };
}
