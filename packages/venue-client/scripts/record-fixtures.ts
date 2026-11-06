// Records the venue fixtures used by unit tests: public market-data reads only (GET, or a Hyperliquid POST /info).
// Never records any path that needs a signature. Each file stays under 200 KB; long lists are trimmed and the trim is
// written into the file. Re-run after a venue changes its API:
//   bun packages/venue-client/scripts/record-fixtures.ts [only-prefix]
import { VENUE_HOSTS } from "@capstan/schema";
import { createMemoryGovernor } from "../src/governor";
import { venueHttp } from "../src/http";
import { recordFixture, writeDocumentedFixture, type FixtureRecord } from "../src/fixtures";

const gov = createMemoryGovernor("fixture-recorder");
const only = process.argv[2];

const hl = venueHttp("hyperliquid", VENUE_HOSTS.hyperliquid.rest, gov);
const l304 = venueHttp("lighter-304", VENUE_HOSTS.lighterMainnet.rest, gov);
const lrh = venueHttp("lighter-466324", VENUE_HOSTS.lighterRh.rest, gov);
const aster = venueHttp("aster", VENUE_HOSTS.aster.rest, gov);
const vari = venueHttp("variational", VENUE_HOSTS.variational.rest, gov);
const arcus = venueHttp("arcus", VENUE_HOSTS.arcus.rest, gov);

type Trim = (r: unknown) => { response: unknown; trimmed?: FixtureRecord["trimmed"] };

/** Keep the first `n` items of a list plus every item `keep` selects (closed or delisted items stay in). */
function trimList<T>(list: T[], n: number, keep: (x: T) => boolean, path: string, rule: string): { list: T[]; trimmed?: FixtureRecord["trimmed"] } {
  if (list.length <= n) return { list };
  const kept = list.filter((x, i) => i < n || keep(x));
  return { list: kept, trimmed: { path, kept: kept.length, total: list.length, rule } };
}

const trimKey =
  <K extends string>(key: K, n: number, keep: (x: Record<string, unknown>) => boolean, rule: string): Trim =>
  (r) => {
    const o = r as Record<K, Record<string, unknown>[]>;
    const t = trimList(o[key], n, keep, key, rule);
    return { response: { ...o, [key]: t.list }, trimmed: t.trimmed };
  };

const trimArray =
  (n: number, keep: (x: Record<string, unknown>) => boolean, rule: string): Trim =>
  (r) => {
    const t = trimList(r as Record<string, unknown>[], n, keep, "[]", rule);
    return { response: t.list, trimmed: t.trimmed };
  };

const hour = 3_600_000;
const now = Date.now();

const jobs: [string, () => Promise<unknown>, Parameters<typeof recordFixture>[2]?][] = [
  // Hyperliquid (info POST reads)
  ["hyperliquid/meta", () => hl.postJson("/info", { type: "meta" })],
  ["hyperliquid/metaAndAssetCtxs", () => hl.postJson("/info", { type: "metaAndAssetCtxs" })],
  ["hyperliquid/metaAndAssetCtxs_xyz", () => hl.postJson("/info", { type: "metaAndAssetCtxs", dex: "xyz" })],
  ["hyperliquid/metaAndAssetCtxs_io", () => hl.postJson("/info", { type: "metaAndAssetCtxs", dex: "io" })],
  ["hyperliquid/metaAndAssetCtxs_para", () => hl.postJson("/info", { type: "metaAndAssetCtxs", dex: "para" })],
  ["hyperliquid/perpDexs", () => hl.postJson("/info", { type: "perpDexs" })],
  ["hyperliquid/l2Book_BTC", () => hl.postJson("/info", { type: "l2Book", coin: "BTC" })],
  ["hyperliquid/l2Book_xyzTSLA", () => hl.postJson("/info", { type: "l2Book", coin: "xyz:TSLA" })],
  ["hyperliquid/fundingHistory_BTC", () => hl.postJson("/info", { type: "fundingHistory", coin: "BTC", startTime: now - 24 * hour })],
  ["hyperliquid/predictedFundings", () => hl.postJson("/info", { type: "predictedFundings" })],
  ["hyperliquid/perpDexLimits_xyz", () => hl.postJson("/info", { type: "perpDexLimits", dex: "xyz" })],
  ["hyperliquid/error_unknownType", () => hl.postJson("/info", { type: "capstanUnknownInfoType" }), { expectStatus: 422, note: "unknown info type: plain-text deserialize error" }],
  // Lighter mainnet (304) and Lighter-RH (466324)
  ["lighter-304/orderBooks", () => l304.getJson("/api/v1/orderBooks"), { trim: trimKey("order_books", 40, (x) => x.status === "inactive" || x.market_type === "spot" || ["BTC", "ETH", "SOL"].includes(String(x.symbol)), "first 40 plus BTC, ETH, SOL, inactive and spot books") }],
  [
    "lighter-304/orderBookDetails",
    () => l304.getJson("/api/v1/orderBookDetails"),
    { trim: (r) => {
        const o = r as { order_book_details: Record<string, unknown>[]; spot_order_book_details?: Record<string, unknown>[] };
        const t = trimList(o.order_book_details, 15, (x) => x.status === "inactive" && o.order_book_details.filter((y) => y.status === "inactive").indexOf(x) < 2, "order_book_details", "first 15 plus 2 inactive");
        return { response: { ...o, order_book_details: t.list, spot_order_book_details: (o.spot_order_book_details ?? []).slice(0, 3) }, trimmed: t.trimmed };
      } },
  ],
  ["lighter-304/fundings", () => l304.getJson("/api/v1/fundings", { market_id: 1, resolution: "1h", start_timestamp: Math.floor((now - 24 * hour) / 1000), end_timestamp: Math.floor(now / 1000), count_back: 24 })],
  ["lighter-304/info", () => l304.getJson("/info")],
  ["lighter-304/root", () => l304.getJson("/")],
  ["lighter-304/error_unknownMarket", () => l304.getJson("/api/v1/accountsByL1Address", { l1_address: "0x0000000000000000000000000000000000000001" }), { expectStatus: 400, note: "unknown L1 address: code 21100" }],
  ["lighter-466324/orderBooks", () => lrh.getJson("/api/v1/orderBooks")],
  [
    "lighter-466324/orderBookDetails",
    () => lrh.getJson("/api/v1/orderBookDetails"),
    { trim: (r) => {
        const o = r as { order_book_details: Record<string, unknown>[]; spot_order_book_details?: Record<string, unknown>[] };
        const t = trimList(o.order_book_details, 15, () => false, "order_book_details", "first 15");
        return { response: { ...o, order_book_details: t.list, spot_order_book_details: (o.spot_order_book_details ?? []).slice(0, 3) }, trimmed: t.trimmed };
      } },
  ],
  ["lighter-466324/fundings", () => lrh.getJson("/api/v1/fundings", { market_id: 11, resolution: "1h", start_timestamp: Math.floor((now - 24 * hour) / 1000), end_timestamp: Math.floor(now / 1000), count_back: 24 })],
  ["lighter-466324/info", () => lrh.getJson("/info")],
  ["lighter-466324/root", () => lrh.getJson("/")],
  // Aster (public market data only; no signed path is ever recorded)
  [
    "aster/exchangeInfo",
    () => aster.getJson("/fapi/v3/exchangeInfo"),
    { trim: (r) => {
        const o = r as { symbols: Record<string, unknown>[] };
        const pick = new Set<Record<string, unknown>>(o.symbols.slice(0, 16));
        const add = (f: (x: Record<string, unknown>) => boolean) => {
          const x = o.symbols.find((s) => f(s) && !pick.has(s));
          if (x) pick.add(x);
        };
        add((s) => s.symbol === "PTBUSDT");
        add((s) => s.symbolType === 1);
        add((s) => s.symbol === "TSLAUSDT");
        add((s) => s.status === "SETTLING");
        add((s) => s.status === "PENDING_TRADING");
        const list = o.symbols.filter((s) => pick.has(s));
        return { response: { ...o, symbols: list }, trimmed: { path: "symbols", kept: list.length, total: o.symbols.length, rule: "first 16 plus PTBUSDT, a stock perp, TSLAUSDT, a SETTLING and a PENDING_TRADING symbol" } };
      } },
  ],
  ["aster/depth_BTCUSDT", () => aster.getJson("/fapi/v3/depth", { symbol: "BTCUSDT", limit: 20 })],
  ["aster/premiumIndex_BTCUSDT", () => aster.getJson("/fapi/v3/premiumIndex", { symbol: "BTCUSDT" })],
  ["aster/fundingInfo", () => aster.getJson("/fapi/v3/fundingInfo"), { trim: trimArray(60, (x) => x.symbol === "PTBUSDT" || x.symbol === "TSLAUSDT", "first 60 plus PTBUSDT and TSLAUSDT") }],
  ["aster/error_invalidSymbol", () => aster.getJson("/fapi/v3/depth", { symbol: "CAPSTANNOPEUSDT", limit: 5 }), { expectStatus: 400, note: "unknown symbol" }],
  // Variational (read-only stats)
  [
    "variational/stats",
    () => vari.getJson("/metadata/v2/stats"),
    { trim: trimKey("listings", 16, (x) => x.contract_type === "swap" || ["BTC-PERP", "ETH-PERP", "SOL-PERP", "QQQ-PERP", "XAU-PERP"].includes(String(x.ticker)), "first 16 plus swaps, BTC, ETH, SOL, QQQ and XAU perps") },
  ],
  // Arcus (public REST)
  ["arcus/markets", () => arcus.getJson("/v1/markets"), { trim: trimKey("markets", 16, (x) => x.status === "OFFLINE" || x.category !== "CRYPTO", "first 16 plus OFFLINE and non-crypto markets") }],
  ["arcus/prices", () => arcus.getJson("/v1/prices"), { trim: (r) => {
      const o = r as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length <= 20) return { response: o };
      return { response: Object.fromEntries(keys.slice(0, 20).map((k) => [k, o[k]])), trimmed: { path: "{}", kept: 20, total: keys.length, rule: "first 20 markets" } };
    } }],
  ["arcus/fundingRates_BTC-USD", () => arcus.getJson("/v1/fundingRates", { market: "BTC-USD" }), { trim: (r) => {
      const list = Array.isArray(r) ? r : ((r as { fundingRates?: unknown[] }).fundingRates ?? []);
      const kept = list.slice(0, 48);
      return { response: Array.isArray(r) ? kept : { ...(r as object), fundingRates: kept }, trimmed: list.length > 48 ? { path: Array.isArray(r) ? "[]" : "fundingRates", kept: 48, total: list.length, rule: "first 48" } : undefined };
    } }],
  ["arcus/bbo_BTC-USD", () => arcus.getJson("/v1/bbo/BTC-USD")],
  ["arcus/l2OrderBook_BTC-USD", () => arcus.getJson("/v1/l2OrderBook/BTC-USD")],
];

let ok = 0;
const failed: string[] = [];
for (const [name, call, opts] of jobs) {
  if (only && !name.startsWith(only)) continue;
  try {
    const r = await recordFixture(name, call, opts);
    console.log(`recorded ${name} (HTTP ${r.status}${r.trimmed ? `, trimmed ${r.trimmed.kept}/${r.trimmed.total}` : ""})`);
    ok++;
  } catch (e) {
    failed.push(`${name}: ${(e as Error).message.slice(0, 160)}`);
  }
}

// A rate-limit answer cannot be triggered on demand without hammering the venue: write the body quoted in the venue
// research (live 429 seen 2026-11-05) as a documented fixture.
if (!only || "variational/error_rateLimited".startsWith(only)) {
  writeDocumentedFixture({
    name: "variational/error_rateLimited",
    capturedAt: "2026-11-05T00:00:00.000Z",
    venue: "variational",
    request: { method: "GET", url: `${VENUE_HOSTS.variational.rest}/metadata/v2/stats`, body: null },
    status: 429,
    response: { error: "rate_limited", message: "Service is busy; try again in 1 seconds", retry_after_seconds: 1 },
    note: "live 429 body seen on the first call during venue research; no Retry-After header",
  });
}

console.log(`record-fixtures: ${ok} recorded, ${failed.length} failed`);
for (const f of failed) console.log(`  failed ${f}`);
