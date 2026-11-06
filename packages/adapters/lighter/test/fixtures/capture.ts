// Records the Lighter fixtures this package's tests read, from live keyless GET calls on both configs, through the
// shared venue-client recorder (reads only: anything else is refused before it is sent) and the 1 req/s governor.
//   bun packages/adapters/lighter/test/fixtures/capture.ts [name ...]   (writes test/fixtures/<venue key>/*.json)
// With names, only those fixtures are re-recorded (the market counts in orderBooks are test inputs: keep them).
// Lists keep every entry (the market counts are test inputs) but only the fields the adapter reads. Account reads are
// public venue data; the L1 address in them is replaced with a fixed placeholder so no third-party wallet is named.
import { createMemoryGovernor, recordFixture, venueHttp, type RecordOptions } from "@capstan/venue-client";
import { join } from "node:path";

const DIR = import.meta.dir;
const PLACEHOLDER_L1 = "0x00000000000000000000000000000000000A11CE";

const BOOK_FIELDS = ["symbol", "market_id", "market_type", "status", "min_base_amount", "min_quote_amount", "supported_size_decimals", "supported_price_decimals", "supported_quote_decimals", "size_decimals", "price_decimals"];
const DETAIL_FIELDS = ["symbol", "market_id", "market_type", "status", "min_base_amount", "min_quote_amount", "size_decimals", "price_decimals", "multiplier", "default_initial_margin_fraction", "maintenance_margin_fraction", "mark_price", "index_price", "open_interest", "market_config", "funding_clamp_small", "funding_clamp_big", "base_interest_rate"];
const CONFIG_FIELDS = ["market_margin_mode", "force_reduce_only", "trading_hours", "hidden"];

const pick = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, k === "market_config" && o[k] && typeof o[k] === "object" ? pick(o[k] as Record<string, unknown>, CONFIG_FIELDS) : o[k]]));

function slimList(path: string, keys: string[], rule: string): RecordOptions["trim"] {
  return (r) => {
    const body = r as Record<string, unknown>;
    const out: Record<string, unknown> = { ...body };
    let total = 0;
    for (const p of path.split(",")) {
      const list = (body[p] as Record<string, unknown>[] | undefined) ?? [];
      total += list.length;
      out[p] = list.map((e) => pick(e, keys));
    }
    return { response: out, trimmed: { path, kept: total, total, rule } };
  };
}

function anonymise(r: unknown): { response: unknown } {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "l1_address" ? PLACEHOLDER_L1 : walk(x)]));
    return v;
  };
  return { response: walk(r) };
}

async function config(venue: "lighter-304" | "lighter-466324", base: string, account: number, fundingMarket: number) {
  const gov = createMemoryGovernor("fixture-capture");
  const http = venueHttp(venue, base, gov, { maxTries: 1 });
  const only = process.argv.slice(2);
  const rec = async (name: string, call: () => Promise<unknown>, opts: RecordOptions = {}) => {
    if (only.length && !only.includes(name)) return;
    await recordFixture(`${venue}/${name}`, call, { dir: DIR, ...opts });
  };
  const now = Math.floor(Date.now() / 1000);
  await rec("root", () => http.getJson("/"));
  await rec("info", () => http.getJson("/info"));
  await rec("orderBooks", () => http.getJson("/api/v1/orderBooks"), { trim: slimList("order_books", BOOK_FIELDS, "every book, adapter fields only") });
  await rec("orderBookDetails", () => http.getJson("/api/v1/orderBookDetails"), {
    trim: slimList("order_book_details,spot_order_book_details", DETAIL_FIELDS, "every market, adapter fields only (daily stats and charts dropped)"),
  });
  await rec("fundings", () => http.getJson("/api/v1/fundings", { market_id: fundingMarket, resolution: "1h", start_timestamp: now - 86_400, end_timestamp: now, count_back: 24 }));
  await rec("assetDetails", () => http.getJson("/api/v1/assetDetails"));
  await rec("systemConfig", () => http.getJson("/api/v1/systemConfig"));
  await rec("feeTiers", () => http.getJson("/api/v1/feeTiers"), { expectStatus: venue === "lighter-466324" ? 403 : undefined });
  await rec("accountsByL1Address_none", () => http.getJson("/api/v1/accountsByL1Address", { l1_address: "0x000000000000000000000000000000000000dEaD" }), { expectStatus: 400 });
  await rec("account", () => http.getJson("/api/v1/account", { by: "index", value: account }), { trim: anonymise, note: "l1_address replaced with a placeholder" });
  await rec("apikeys", () => http.getJson("/api/v1/apikeys", { account_index: account, api_key_index: 255 }));
  await rec("orderBookOrders", () => http.getJson("/api/v1/orderBookOrders", { market_id: 0, limit: 20 }));
  if (!only.length || only.includes("books")) {
    // 25 recorded books per config for the quote == execution test (top 20 orders per side, owner indexes dropped)
    const list = (await http.getJson<{ order_books: { market_id: number; symbol: string; market_type: string; status: string }[] }>("/api/v1/orderBooks")).order_books;
    const perps = list.filter((b) => b.market_type === "perp" && b.status === "active").slice(0, 25);
    const books: unknown[] = [];
    for (const b of perps) {
      const r = await http.getJson<{ asks: Record<string, unknown>[]; bids: Record<string, unknown>[] }>("/api/v1/orderBookOrders", { market_id: b.market_id, limit: 20 });
      const keep = (o: Record<string, unknown>) => ({ price: o.price, remaining_base_amount: o.remaining_base_amount });
      books.push({ market_id: b.market_id, symbol: b.symbol, asks: r.asks.map(keep), bids: r.bids.map(keep) });
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(DIR, venue, "books25.json"), JSON.stringify({ name: `${venue}/books25`, capturedAt: new Date().toISOString(), source: "live", venue, request: { method: "GET", url: `${base}/api/v1/orderBookOrders?market_id=<each>&limit=20`, body: null }, status: 200, response: books, note: "25 active perps, owner account indexes dropped" }, null, 1) + "\n");
  }
  await rec("nextNonce", () => http.getJson("/api/v1/nextNonce", { account_index: account, api_key_index: 4 }));
}

if (import.meta.main) {
  await config("lighter-304", "https://mainnet.zklighter.elliot.ai", 3, 1);
  await config("lighter-466324", "https://api.rh.lighter.xyz", 3, 11);
  console.log(`fixtures written under ${join(DIR)}`);
}
