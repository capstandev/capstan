// Recorded venue responses for unit tests. recordFixture only records reads (GET, or a Hyperliquid POST /info): any
// other request is refused before it is sent, so no exchange action or sendTx is ever captured. Each fixture keeps
// the request, the HTTP status and capturedAt next to the response, and stays under 200 KB (large lists are trimmed,
// and the trim is written into the file).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VenueKey } from "./budgets";
import type { Method, RawResponse } from "./http";
import { parseJsonLossless } from "./json";
import { withRecorder, type Recorder } from "./record-context";

export const FIXTURES_DIR = join(import.meta.dir, "../fixtures");
export const MAX_FIXTURE_BYTES = 200 * 1024;

export interface FixtureRecord<T = unknown> {
  name: string; // "<venue folder>/<name>"
  capturedAt: string;
  source: "live" | "documented"; // documented = a live body quoted in the venue research (cannot be triggered on demand)
  venue: VenueKey | string;
  request: { method: Method; url: string; body: unknown };
  status: number;
  response: T;
  trimmed?: { path: string; kept: number; total: number; rule: string };
  note?: string;
}

export function isReadOnlyRequest(venue: string, method: Method, path: string): boolean {
  if (method === "GET") return true;
  return method === "POST" && venue.startsWith("hyperliquid") && path === "/info";
}

export class RecordRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordRefused";
  }
}

export interface RecordOptions {
  dir?: string;
  /** Shrink the response; return the trim note so the file says what was cut. */
  trim?: (response: unknown) => { response: unknown; trimmed?: FixtureRecord["trimmed"] };
  note?: string;
  /** Record a non-2xx answer on purpose (error-body fixtures). */
  expectStatus?: number;
}

/** Run `call` (which makes exactly one venue read through venueHttp) and write fixtures/<name>.json. */
export async function recordFixture(name: string, call: () => Promise<unknown>, opts: RecordOptions = {}): Promise<FixtureRecord> {
  if (!/^[a-z0-9-]+\/[A-Za-z0-9_.:-]+$/.test(name)) throw new RecordRefused(`recordFixture: name must be <venue>/<name>, got ${name}`);
  const captured: { venue: VenueKey; method: Method; url: string; body: unknown; raw: RawResponse }[] = [];
  const rec: Recorder = {
    check(venue, method, path) {
      if (!isReadOnlyRequest(venue, method, path)) throw new RecordRefused(`recordFixture: refusing to record ${method} ${path} on ${venue} (reads only)`);
    },
    capture(venue, method, url, body, raw) {
      captured.push({ venue, method, url, body, raw });
    },
  };
  try {
    await withRecorder(rec, call);
  } catch (e) {
    if (e instanceof RecordRefused) throw e;
    if (!(opts.expectStatus && captured.length)) throw e;
  }
  const c = captured[captured.length - 1];
  if (!c) throw new RecordRefused(`recordFixture: ${name}: the call made no venue request`);
  let response = c.raw.body;
  let trimmed: FixtureRecord["trimmed"];
  if (opts.trim) ({ response, trimmed } = opts.trim(response));
  const record: FixtureRecord = {
    name,
    capturedAt: new Date().toISOString(),
    source: "live",
    venue: c.venue,
    request: { method: c.method, url: c.url, body: c.body },
    status: c.raw.httpStatus,
    response,
    ...(trimmed ? { trimmed } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  };
  const text = JSON.stringify(record, null, 1) + "\n";
  if (text.length > MAX_FIXTURE_BYTES) throw new RecordRefused(`recordFixture: ${name} is ${text.length} bytes (max ${MAX_FIXTURE_BYTES}); add a trim`);
  const path = join(opts.dir ?? FIXTURES_DIR, `${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return record;
}

export function fixturePath(venue: string, name: string, dir = FIXTURES_DIR): string {
  return join(dir, venue, `${name}.json`);
}

export function loadFixtureRecord<T>(venue: string, name: string, dir = FIXTURES_DIR): FixtureRecord<T> {
  const p = fixturePath(venue, name, dir);
  if (!existsSync(p)) throw new Error(`fixture ${venue}/${name} is missing (record it with packages/venue-client/scripts/record-fixtures.ts)`);
  return parseJsonLossless(readFileSync(p, "utf8")) as FixtureRecord<T>;
}

/** The recorded response body. */
export function loadFixture<T>(venue: string, name: string, dir = FIXTURES_DIR): T {
  return loadFixtureRecord<T>(venue, name, dir).response;
}

// ------------------------------------------------------------- required fields per fixture
// Field paths the adapters read. `a[].b` checks every element of array `a`; `[0].x` indexes a tuple.

export const FIXTURE_SPECS: Record<string, string[]> = {
  "hyperliquid/meta": ["universe[].name", "universe[].szDecimals", "universe[].maxLeverage", "marginTables"],
  "hyperliquid/metaAndAssetCtxs": ["[0].universe[].name", "[0].universe[].szDecimals", "[1][].funding", "[1][].markPx", "[1][].openInterest", "[1][].oraclePx", "[1][].premium"],
  "hyperliquid/metaAndAssetCtxs_xyz": ["[0].universe[].name", "[0].universe[].szDecimals", "[1][].funding", "[1][].markPx", "[1][].openInterest"],
  "hyperliquid/metaAndAssetCtxs_io": ["[0].universe[].name", "[1][].funding", "[1][].markPx"],
  "hyperliquid/metaAndAssetCtxs_para": ["[0].universe[].name", "[1][].funding", "[1][].markPx"],
  "hyperliquid/perpDexs": ["[1].name", "[1].fullName", "[1].deployer"],
  "hyperliquid/l2Book_BTC": ["coin", "time", "levels[0][].px", "levels[0][].sz", "levels[1][].px", "levels[1][].sz"],
  "hyperliquid/l2Book_xyzTSLA": ["coin", "time", "levels[0][].px", "levels[1][].px"],
  "hyperliquid/fundingHistory_BTC": ["[].coin", "[].fundingRate", "[].premium", "[].time"],
  "hyperliquid/predictedFundings": ["[0][0]", "[0][1]"],
  "hyperliquid/perpDexLimits_xyz": ["totalOiCap", "oiSzCapPerPerp"],
  "hyperliquid/error_unknownType": [],
  "lighter-304/orderBooks": ["order_books[].symbol", "order_books[].market_id", "order_books[].status", "order_books[].supported_size_decimals", "order_books[].supported_price_decimals"],
  "lighter-304/orderBookDetails": ["order_book_details[].symbol", "order_book_details[].market_id", "order_book_details[].last_trade_price", "order_book_details[].open_interest"],
  "lighter-304/fundings": ["resolution", "fundings[].timestamp", "fundings[].rate", "fundings[].direction"],
  "lighter-304/info": [],
  "lighter-304/root": [],
  "lighter-304/error_unknownMarket": ["code"],
  "lighter-466324/orderBooks": ["order_books[].symbol", "order_books[].market_id", "order_books[].status", "order_books[].market_type"],
  "lighter-466324/orderBookDetails": ["order_book_details[].symbol", "order_book_details[].market_id"],
  "lighter-466324/fundings": ["fundings[].timestamp", "fundings[].rate"],
  "lighter-466324/info": [],
  "lighter-466324/root": [],
  "aster/exchangeInfo": ["rateLimits[].rateLimitType", "rateLimits[].limit", "symbols[].symbol", "symbols[].status", "symbols[].marginAsset", "symbols[].filters", "symbols[].symbolType"],
  "aster/depth_BTCUSDT": ["lastUpdateId", "bids", "asks"],
  "aster/premiumIndex_BTCUSDT": ["markPrice", "indexPrice", "lastFundingRate", "nextFundingTime", "time"],
  "aster/fundingInfo": ["[].symbol", "[].fundingIntervalHours", "[].fundingFeeCap", "[].fundingFeeFloor"],
  "aster/error_invalidSymbol": ["code", "msg"],
  "variational/stats": ["listings[].ticker", "listings[].mark_price", "listings[].funding.interval_seconds", "listings[].funding.next", "listings[].contract_type", "listings[].open_interest"],
  "variational/error_rateLimited": ["error", "retry_after_seconds"],
  "arcus/markets": ["markets[].marketId", "markets[].marketDisplayName", "markets[].status", "markets[].tickSize", "markets[].stepSize", "markets[].markPrice", "markets[].fundingRate", "markets[].nextFundingAt", "markets[].category", "markets[].type"],
  "arcus/prices": [],
  "arcus/fundingRates_BTC-USD": ["fundingRates[].fundingRate", "fundingRates[].time"],
  "arcus/bbo_BTC-USD": ["bestBid.price", "bestAsk.price", "timestamp"],
  "arcus/l2OrderBook_BTC-USD": ["bids", "asks"],
};

function walkPath(v: unknown, parts: string[], at: string, missing: string[]): void {
  if (!parts.length) {
    if (v === undefined) missing.push(at);
    return;
  }
  const [head, ...rest] = parts;
  if (head === "[]") {
    if (!Array.isArray(v) || v.length === 0) {
      missing.push(`${at}[] (not a non-empty array)`);
      return;
    }
    v.forEach((x, i) => walkPath(x, rest, `${at}[${i}]`, missing));
    return;
  }
  const idx = /^\[(\d+)\]$/.exec(head!);
  if (idx) {
    const x = Array.isArray(v) ? v[Number(idx[1])] : undefined;
    if (x === undefined) {
      missing.push(`${at}${head}`);
      return;
    }
    walkPath(x, rest, `${at}${head}`, missing);
    return;
  }
  const x = v && typeof v === "object" ? (v as Record<string, unknown>)[head!] : undefined;
  if (x === undefined) {
    missing.push(`${at}.${head}`);
    return;
  }
  walkPath(x, rest, `${at}.${head}`, missing);
}

export function splitPath(p: string): string[] {
  return p.match(/\[\]|\[\d+\]|[^.[\]]+/g) ?? [];
}

/** Paths from `spec` the response lacks (an empty list means the fixture has every field the adapters read). */
export function missingFields(response: unknown, spec: string[]): string[] {
  const missing: string[] = [];
  for (const p of spec) walkPath(response, splitPath(p), "", missing);
  return missing;
}

/** Write a documented error body (one that cannot be triggered on demand) as a fixture, marked source: documented. */
export function writeDocumentedFixture(rec: Omit<FixtureRecord, "source">, dir = FIXTURES_DIR): void {
  const path = join(dir, `${rec.name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...rec, source: "documented" }, null, 1) + "\n");
}
