// Independent market facts for the payload check. The asset id, decimals and reference price a build is compared with
// come from the VENUE's own public endpoints, never from the Capstan server that made the build (a compromised server
// could otherwise send a wrong market and a matching wrong map). Keyless reads only.
import { VENUE_HOSTS, type VenueId } from "@capstan/schema";
import { SdkError } from "./errors";
import type { Network } from "./pins";

export type VenueMarketSpec =
  | { venue: "hyperliquid"; marketId: string; assetId: number; szDecimals: number }
  | { venue: "lighter-mainnet" | "lighter-rh"; marketId: string; marketIndex: number; sizeDecimals: number; priceDecimals: number }
  | { venue: "aster"; marketId: string; symbol: string };

export interface MarketSource {
  spec(venue: VenueId, marketId: string): Promise<VenueMarketSpec>;
  /** An independent reference price (mark or mid) for market-order slippage checks; null when unknown. */
  refPx(venue: VenueId, marketId: string): Promise<string | null>;
}

/** Spec 3 market id parts: `${venue}:${dex ?? '-'}:${symbol}`. */
export function parseMarketId(id: string): { venue: string; dex: string | null; symbol: string } {
  const m = /^([a-z0-9-]+):([a-z0-9]+|-):(.+)$/.exec(id);
  if (!m) throw new SdkError("INVALID_INPUT", `not a market id: ${id.slice(0, 60)}`, { field: "marketId" });
  return { venue: m[1]!, dex: m[2] === "-" ? null : m[2]!, symbol: m[3]! };
}

export const hlAssetId = (dexIndex: number, indexInMeta: number): number => (dexIndex === 0 ? indexInMeta : 100000 + dexIndex * 10000 + indexInMeta);

/** HL meta universe to specs. `universe` is the raw list (delisted entries count toward the index). */
export function hlSpecsFromMeta(universe: { name: string; szDecimals: number }[], dexIndex: number, dex: string | null): Map<string, VenueMarketSpec> {
  const out = new Map<string, VenueMarketSpec>();
  universe.forEach((u, i) => {
    const sym = dex && u.name.startsWith(`${dex}:`) ? u.name.slice(dex.length + 1) : u.name;
    const id = `hyperliquid:${dex ?? "-"}:${sym}`;
    out.set(id, { venue: "hyperliquid", marketId: id, assetId: hlAssetId(dexIndex, i), szDecimals: u.szDecimals });
  });
  return out;
}

interface LighterDetail {
  symbol: string;
  market_id: number;
  size_decimals?: number;
  price_decimals?: number;
  supported_size_decimals?: number;
  supported_price_decimals?: number;
  mark_price?: string;
  last_trade_price?: number | string;
}

export function lighterSpecsFromDetails(venue: "lighter-mainnet" | "lighter-rh", details: LighterDetail[]): Map<string, VenueMarketSpec & { mark?: string }> {
  const out = new Map<string, VenueMarketSpec & { mark?: string }>();
  for (const d of details) {
    const sizeDecimals = d.size_decimals ?? d.supported_size_decimals;
    const priceDecimals = d.price_decimals ?? d.supported_price_decimals;
    if (!Number.isInteger(sizeDecimals) || !Number.isInteger(priceDecimals) || !Number.isInteger(d.market_id)) continue;
    const id = `${venue}:-:${d.symbol}`;
    out.set(id, { venue, marketId: id, marketIndex: d.market_id, sizeDecimals: sizeDecimals!, priceDecimals: priceDecimals!, ...(d.mark_price ? { mark: String(d.mark_price) } : {}) });
  }
  return out;
}

export interface PublicVenueMarketsOptions {
  network: Network;
  fetch?: typeof fetch;
  /** Base URLs per venue (tests point these at fake venues). Default: VENUE_HOSTS for the network. */
  hosts?: Partial<Record<VenueId, string>>;
  cacheMs?: number;
  now?: () => number;
}

export function defaultVenueHosts(network: Network): Record<"hyperliquid" | "lighter-mainnet" | "lighter-rh" | "aster", string> {
  const t = network === "testnet";
  return {
    hyperliquid: (t ? VENUE_HOSTS.hyperliquidTestnet : VENUE_HOSTS.hyperliquid).rest,
    "lighter-mainnet": (t ? VENUE_HOSTS.lighterMainnetTestnet : VENUE_HOSTS.lighterMainnet).rest,
    "lighter-rh": (t ? VENUE_HOSTS.lighterRhTestnet : VENUE_HOSTS.lighterRh).rest,
    aster: (t ? VENUE_HOSTS.asterTestnet : VENUE_HOSTS.aster).rest,
  };
}

/** Reads market specs and reference prices from each venue's public endpoints, cached for `cacheMs` (default 5 min). */
export function publicVenueMarkets(o: PublicVenueMarketsOptions): MarketSource {
  const f = o.fetch ?? fetch;
  const hosts = { ...defaultVenueHosts(o.network), ...(o.hosts ?? {}) } as Record<string, string>;
  const ttl = o.cacheMs ?? 5 * 60_000;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; v: Promise<unknown> }>();
  const cached = <T>(k: string, fn: () => Promise<T>, life = ttl): Promise<T> => {
    const c = cache.get(k);
    if (c && now() - c.at < life) return c.v as Promise<T>;
    const v = fn();
    cache.set(k, { at: now(), v });
    v.catch(() => cache.delete(k));
    return v;
  };
  const hostOf = (venue: string) => {
    const h = hosts[venue];
    if (!h) throw new SdkError("UNSUPPORTED", `no public host for ${venue}`);
    return h.replace(/\/$/, "");
  };
  const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const r = await f(url, init);
    if (!r.ok) throw new SdkError("VENUE_ERROR", `venue read failed (${r.status})`);
    return (await r.json()) as T;
  };
  const hlInfo = <T>(body: unknown) => json<T>(`${hostOf("hyperliquid")}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function hlSpecs(dex: string | null): Promise<Map<string, VenueMarketSpec>> {
    return cached(`hl:${dex ?? "-"}`, async () => {
      if (dex === null) return hlSpecsFromMeta((await hlInfo<{ universe: { name: string; szDecimals: number }[] }>({ type: "meta" })).universe, 0, null);
      const dexes = await hlInfo<({ name: string } | null)[]>({ type: "perpDexs" });
      const idx = dexes.findIndex((d) => d !== null && d.name === dex);
      if (idx <= 0) throw new SdkError("INVALID_INPUT", `unknown HIP-3 dex ${dex}`, { field: "marketId" });
      return hlSpecsFromMeta((await hlInfo<{ universe: { name: string; szDecimals: number }[] }>({ type: "meta", dex })).universe, idx, dex);
    });
  }
  async function lighterSpecs(venue: "lighter-mainnet" | "lighter-rh") {
    return cached(`${venue}:details`, async () => lighterSpecsFromDetails(venue, (await json<{ order_book_details?: LighterDetail[] }>(`${hostOf(venue)}/api/v1/orderBookDetails`)).order_book_details ?? []), Math.min(ttl, 30_000));
  }

  return {
    async spec(venue, marketId) {
      const p = parseMarketId(marketId);
      if (p.venue !== venue) throw new SdkError("PAYLOAD_MISMATCH", "the market id names another venue", { field: "market" });
      let s: VenueMarketSpec | undefined;
      if (venue === "hyperliquid") s = (await hlSpecs(p.dex)).get(marketId);
      else if (venue === "lighter-mainnet" || venue === "lighter-rh") s = (await lighterSpecs(venue)).get(marketId);
      else if (venue === "aster") s = { venue: "aster", marketId, symbol: p.symbol };
      else throw new SdkError("UNSUPPORTED", `${venue} is data only`);
      if (!s) throw new SdkError("INVALID_INPUT", `the venue does not list ${marketId}`, { field: "marketId" });
      return s;
    },
    async refPx(venue, marketId) {
      const p = parseMarketId(marketId);
      try {
        if (venue === "hyperliquid") {
          const mids = await cached(`hl:mids:${p.dex ?? "-"}`, () => hlInfo<Record<string, string>>(p.dex ? { type: "allMids", dex: p.dex } : { type: "allMids" }), 2_000);
          return mids[p.dex ? `${p.dex}:${p.symbol}` : p.symbol] ?? null;
        }
        if (venue === "lighter-mainnet" || venue === "lighter-rh") {
          const s = (await lighterSpecs(venue)).get(marketId);
          return s?.mark ?? null;
        }
        if (venue === "aster") {
          const r = await cached(`aster:mark:${p.symbol}`, () => json<{ markPrice?: string }>(`${hostOf("aster")}/fapi/v3/premiumIndex?symbol=${encodeURIComponent(p.symbol)}`), 2_000);
          return r.markPrice ?? null;
        }
      } catch {
        return null;
      }
      return null;
    },
  };
}

/** A fixed source for tests and hosts that pin their own map. */
export function staticMarketSource(specs: VenueMarketSpec[], refs: Record<string, string> = {}): MarketSource {
  const m = new Map(specs.map((s) => [s.marketId, s]));
  return {
    async spec(venue, id) {
      const s = m.get(id);
      if (!s || s.venue !== venue) throw new SdkError("INVALID_INPUT", `unknown market ${id}`, { field: "marketId" });
      return s;
    },
    async refPx(_v, id) {
      return refs[id] ?? null;
    },
  };
}
