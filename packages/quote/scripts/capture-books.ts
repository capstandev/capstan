// Capture recorded books for the golden tests (public unsigned reads only; run by hand, never in CI):
//   bun packages/quote/scripts/capture-books.ts
// Writes test/fixtures/books/<venue>.json: 20 books per venue plus the market meta the quote needs (lot, tick,
// collateral, size decimals, margin fractions). Lighter books are aggregated from orderBookOrders by price.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "../test/fixtures/books");
mkdirSync(OUT, { recursive: true });
const N = 20;
const sleep = (ms: number) => Bun.sleep(ms);

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    if (r.status === 429) {
      await sleep(2000 * (i + 1));
      continue;
    }
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return (await r.json()) as T;
  }
  throw new Error(`${url}: rate limited`);
}

type Level = [string, string];
interface Rec {
  marketId: string;
  venueSymbol: string;
  meta: Record<string, unknown>;
  book: { bids: Level[]; asks: Level[]; asOf: string };
}

function write(name: string, url: string, books: Rec[], note: string) {
  const body = { name: `books/${name}`, capturedAt: new Date().toISOString(), source: "live", request: { method: name.startsWith("hyperliquid") ? "POST" : "GET", url }, note, books };
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(body, null, 1) + "\n");
  console.log(`${name}: ${books.length} books`);
}

async function hyperliquid(dex: string | null) {
  const info = "https://api.hyperliquid.xyz/info";
  const post = <T>(b: unknown) => getJson<T>(info, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const meta = await post<{ universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean; growthMode?: string; deployerFeeScale?: string; onlyIsolated?: boolean }[]; collateralToken?: number }>(dex ? { type: "meta", dex } : { type: "meta" });
  const live = meta.universe.filter((u) => !u.isDelisted).slice(0, N);
  const out: Rec[] = [];
  for (const u of live) {
    const b = await post<{ coin: string; time: number; levels: [{ px: string; sz: string }[], { px: string; sz: string }[]] }>({ type: "l2Book", coin: u.name });
    const sym = dex ? u.name.slice(dex.length + 1) : u.name;
    out.push({
      marketId: `hyperliquid:${dex ?? "-"}:${sym}`,
      venueSymbol: u.name,
      meta: { dex, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, collateralToken: meta.collateralToken ?? 0, growthMode: u.growthMode ?? null, deployerFeeScale: u.deployerFeeScale ?? null, onlyIsolated: u.onlyIsolated ?? false },
      book: { bids: b.levels[0].map((l) => [l.px, l.sz]), asks: b.levels[1].map((l) => [l.px, l.sz]), asOf: new Date(b.time).toISOString() },
    });
    await sleep(150);
  }
  write(dex ? `hyperliquid-${dex}` : "hyperliquid-core", info, out, `${N} live markets from meta${dex ? ` dex ${dex}` : ""}; l2Book per coin`);
}

async function lighter(venue: "lighter-mainnet" | "lighter-rh", host: string) {
  const det = await getJson<{ order_book_details: { symbol: string; market_id: number; market_type: string; status: string; size_decimals: number; price_decimals: number; min_base_amount: string; default_initial_margin_fraction: number; maintenance_margin_fraction: number; mark_price: string }[] }>(`${host}/api/v1/orderBookDetails`);
  const perps = det.order_book_details.filter((d) => d.market_type === "perp" && d.status === "active").slice(0, N);
  const out: Rec[] = [];
  for (const d of perps) {
    await sleep(1200); // 1 request per second per config
    const o = await getJson<{ asks: { price: string; remaining_base_amount: string }[]; bids: { price: string; remaining_base_amount: string }[] }>(`${host}/api/v1/orderBookOrders?market_id=${d.market_id}&limit=50`);
    const agg = (xs: { price: string; remaining_base_amount: string }[]) => {
      const m = new Map<string, bigint>();
      const dec = d.size_decimals;
      const toU = (s: string) => BigInt(s.replace(".", "").padEnd(s.split(".")[0]!.length + dec, "0").slice(0, s.split(".")[0]!.length + dec));
      for (const x of xs) m.set(x.price, (m.get(x.price) ?? 0n) + toU(x.remaining_base_amount));
      const fmt = (u: bigint) => {
        const s = u.toString().padStart(dec + 1, "0");
        return dec ? `${s.slice(0, -dec)}.${s.slice(-dec)}` : s;
      };
      return [...m.entries()].map(([p, u]) => [p, fmt(u)] as Level);
    };
    out.push({
      marketId: `${venue}:-:${d.symbol}`,
      venueSymbol: d.symbol,
      meta: { marketIndex: d.market_id, sizeDecimals: d.size_decimals, priceDecimals: d.price_decimals, minBaseAmount: d.min_base_amount, imf: d.default_initial_margin_fraction, mmf: d.maintenance_margin_fraction, markPx: d.mark_price },
      book: { bids: agg(o.bids), asks: agg(o.asks), asOf: new Date().toISOString() },
    });
  }
  write(venue, `${host}/api/v1/orderBookOrders?market_id=<each>&limit=50`, out, `${N} active perps from orderBookDetails; orders aggregated by price; owner account indexes dropped`);
}

async function aster() {
  const host = "https://fapi.asterdex.com";
  const info = await getJson<{ symbols: { symbol: string; status: string; contractType: string; marginAsset: string; filters: { filterType: string; tickSize?: string; stepSize?: string; notional?: string }[] }[] }>(`${host}/fapi/v3/exchangeInfo`);
  const syms = info.symbols.filter((s) => s.status === "TRADING" && s.contractType === "PERPETUAL").slice(0, N);
  const out: Rec[] = [];
  for (const s of syms) {
    const b = await getJson<{ bids: Level[]; asks: Level[]; T?: number; E?: number }>(`${host}/fapi/v3/depth?symbol=${s.symbol}&limit=20`);
    const f = (t: string) => s.filters.find((x) => x.filterType === t);
    out.push({
      marketId: `aster:-:${s.symbol}`,
      venueSymbol: s.symbol,
      meta: { tickSize: f("PRICE_FILTER")?.tickSize, stepSize: f("LOT_SIZE")?.stepSize, minNotional: f("MIN_NOTIONAL")?.notional ?? null, marginAsset: s.marginAsset },
      book: { bids: b.bids, asks: b.asks, asOf: new Date(b.T ?? b.E ?? Date.now()).toISOString() },
    });
    await sleep(150);
  }
  write("aster", `${host}/fapi/v3/depth?symbol=<each>&limit=20`, out, `${N} TRADING perps from exchangeInfo`);
}

const only = process.argv[2];
if (!only || only === "hl") await hyperliquid(null);
if (!only || only === "xyz") await hyperliquid("xyz");
if (!only || only === "aster") await aster();
if (!only || only === "l304") await lighter("lighter-mainnet", "https://mainnet.zklighter.elliot.ai");
if (!only || only === "lrh") await lighter("lighter-rh", "https://api.rh.lighter.xyz");
