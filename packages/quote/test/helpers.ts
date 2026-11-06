// Test helpers: recorded live books (test/fixtures/books, captured read-only by scripts/capture-books.ts), markets
// built from the meta captured with them, a cache with no TTL, and fake adapters over that cache.
import type { MarketDataCache } from "@capstan/core";
import { Dec, type CanonicalAsset, type FundingSnapshot, type OrderBook, type VenueCapabilities, type VenueId } from "@capstan/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DepegReader, DepegReading } from "../src/depeg";
import type { QuoteMarket } from "../src/liq";
import type { QuoteAdapter, QuoteDeps } from "../src/route";
import { memoryCatalog } from "../src/catalog";

export const BOOK_SETS = ["hyperliquid-core", "hyperliquid-xyz", "lighter-mainnet", "lighter-rh", "aster"] as const;
export type BookSet = (typeof BOOK_SETS)[number];

export interface RecordedBook {
  marketId: string;
  venueSymbol: string;
  meta: Record<string, unknown>;
  book: { bids: [string, string][]; asks: [string, string][]; asOf: string };
}

export function recorded(set: BookSet): RecordedBook[] {
  return (JSON.parse(readFileSync(join(import.meta.dir, "fixtures/books", `${set}.json`), "utf8")) as { books: RecordedBook[] }).books;
}

const unit = (dp: number) => (dp <= 0 ? "1" : `0.${"0".repeat(dp - 1)}1`);

export function venueOf(set: BookSet): VenueId {
  return set.startsWith("hyperliquid") ? "hyperliquid" : set === "aster" ? "aster" : (set as VenueId);
}

/** A catalog market from the meta recorded with the book. */
export function marketFor(set: BookSet, r: RecordedBook, asset: CanonicalAsset | null = null): QuoteMarket {
  const m = r.meta;
  const venue = venueOf(set);
  const base: QuoteMarket = {
    id: r.marketId,
    venue,
    dex: null,
    venueSymbol: r.venueSymbol,
    marketType: "perp",
    canonicalAsset: asset,
    collateralAsset: "USDC",
    tickSize: "0.000001",
    lotSize: "1",
    minNotional: null,
    maxLeverage: null,
    marginModes: ["cross", "isolated"],
    fundingIntervalS: 3600,
    fundingSettleIntervalS: 3600,
    sessionHours: null,
    oiCapUsd: null,
    builderFeeUnit: null,
    status: "active",
    executable: true,
    dataFreshness: "live",
    updatedAt: "2026-11-06T00:00:00.000Z",
  };
  if (set === "hyperliquid-core" || set === "hyperliquid-xyz") {
    return {
      ...base,
      dex: (m.dex as string | null) ?? null,
      lotSize: unit(Number(m.szDecimals)),
      tickSize: unit(6 - Number(m.szDecimals)),
      maxLeverage: Number(m.maxLeverage),
      fundingIntervalS: 28800,
      builderFeeUnit: "tenths_bp",
      ...(m.dex ? { deployerFeeScale: String(m.deployerFeeScale ?? "1.0"), growthMode: m.growthMode === "enabled" } : {}),
    };
  }
  if (set === "aster") return { ...base, tickSize: String(m.tickSize), lotSize: String(m.stepSize), minNotional: (m.minNotional as string | null) ?? null, collateralAsset: String(m.marginAsset), fundingIntervalS: 28800, builderFeeUnit: "decimal_rate" };
  return {
    ...base,
    lotSize: unit(Number(m.sizeDecimals)),
    tickSize: unit(Number(m.priceDecimals)),
    minNotional: null,
    maxLeverage: Math.floor(10_000 / Number(m.imf)),
    maintenanceMarginFraction: Dec.toString(Dec.div(Dec.parse(String(m.mmf), 0), Dec.parse("10000", 0), 18)),
    collateralAsset: set === "lighter-rh" ? "USDG" : "USDC",
    builderFeeUnit: "ppm",
  };
}

/** A market data cache with no TTL (the engine's own staleness rules decide). */
export function staticCache(): MarketDataCache & { books: Map<string, OrderBook>; marks: Map<string, { mark: string; asOf: string }>; funding: Map<string, FundingSnapshot> } {
  const books = new Map<string, OrderBook>();
  const marks = new Map<string, { mark: string; asOf: string }>();
  const funding = new Map<string, FundingSnapshot>();
  return {
    books,
    marks,
    funding,
    async putBook(b) {
      books.set(b.marketId, b);
    },
    async getBook(id) {
      return books.get(id) ?? null;
    },
    async putFunding(f) {
      funding.set(f.marketId, f);
    },
    async getFunding(id) {
      return funding.get(id) ?? null;
    },
    async putMark(id, mark, asOf) {
      marks.set(id, { mark, asOf });
    },
    async getMark(id) {
      return marks.get(id) ?? null;
    },
    async putMeta() {},
  };
}

export function t1Caps(venue: VenueId, execution = true): VenueCapabilities {
  return { venue, execution, keyType: venue.startsWith("lighter") ? "lighter-native" : "secp256k1", delegation: venue.startsWith("lighter") ? "api_key_index" : "agent", canWithdraw: false, builderFee: null, collateral: ["USDC"], directSubmitSupported: true, publicAccountReads: venue !== "aster" };
}

/** A T1 adapter that reads only the cache (a miss is a venue error). */
export function cacheAdapter(venue: VenueId, cache: MarketDataCache, execution = true): QuoteAdapter {
  return {
    caps: t1Caps(venue, execution),
    async getBook(id: string) {
      const b = await cache.getBook(id);
      if (!b) throw new Error("no book");
      return b;
    },
    async getFunding(id) {
      const f = await cache.getFunding(id);
      if (!f) throw new Error("no funding");
      return f;
    },
  };
}

export function funding(marketId: string, ratePerHour: string, asOf: string): FundingSnapshot {
  return { marketId, ratePerInterval: ratePerHour, intervalS: 3600, ratePerHour, rateAnnualised: Dec.toString(Dec.mul(Dec.parse(ratePerHour, 18), Dec.parse("8760", 0), 18)), predictedNext: null, nextSettlementAt: asOf, capPerHour: null, source: "venue", asOf };
}

export function depegOf(usdg: DepegReading | null, usdt: DepegReading | null = null): DepegReader {
  return { usdgUsdcBps: async () => usdg, usdtUsdcBps: async () => usdt };
}

export function deps(over: Partial<QuoteDeps> & { markets: QuoteMarket[]; cache: MarketDataCache; now: () => number }): QuoteDeps {
  const adapters = over.adapters ?? new Map<VenueId, QuoteAdapter>([...new Set(over.markets.map((m) => m.venue))].map((v) => [v, cacheAdapter(v, over.cache)] as const));
  return { depeg: depegOf(null), ...over, adapters, catalog: over.catalog ?? memoryCatalog(over.markets) };
}

/** A simple two-sided book around `mid` with `n` levels of `sz` each `step` apart. */
export function ladder(marketId: string, mid: string, step: string, sz: string, asOf: string, n = 10): OrderBook {
  const m = Dec.parse(mid, 18);
  const s = Dec.parse(step, 18);
  const bids: [string, string][] = [];
  const asks: [string, string][] = [];
  for (let i = 1; i <= n; i++) {
    const k = Dec.mul(s, Dec.parse(String(i), 0), 18);
    bids.push([Dec.toString(Dec.sub(m, k)), sz]);
    asks.push([Dec.toString(Dec.add(m, k)), sz]);
  }
  return { marketId, bids, asks, asOf };
}

export function genericMarket(id: string, venue: VenueId, o: Partial<QuoteMarket> = {}): QuoteMarket {
  const [, dex] = id.split(":");
  return {
    id,
    venue,
    dex: dex === "-" ? null : (dex ?? null),
    venueSymbol: id.split(":")[2]!,
    marketType: "perp",
    canonicalAsset: "CR:ETH",
    collateralAsset: venue === "lighter-rh" || venue === "arcus" ? "USDG" : venue === "aster" ? "USDT" : "USDC",
    tickSize: "0.01",
    lotSize: "0.001",
    minNotional: null,
    maxLeverage: 25,
    marginModes: ["cross"],
    fundingIntervalS: 3600,
    fundingSettleIntervalS: 3600,
    sessionHours: null,
    oiCapUsd: null,
    builderFeeUnit: null,
    status: "active",
    executable: venue !== "variational" && venue !== "arcus",
    dataFreshness: venue === "variational" ? "delayed" : "live",
    updatedAt: "2026-11-06T00:00:00.000Z",
    ...o,
  };
}
