// Keyless Lighter reads for one config. Every REST call goes through the venue HTTP client and its governor (1 request
// per second per config on Standard). Account reads are public by index; no request here carries an auth token unless
// the caller hands one in for the two calls that need it (open orders, fee tier).
import type { MarketDataCache } from "@capstan/core";
import {
  CapstanError,
  Dec,
  type AccountSnapshot,
  type FundingSnapshot,
  type Hex,
  type Market,
  type MarketEvent,
  type Order,
  type OrderBook,
  type Position,
  type Unsubscribe,
  type VenueIdentity,
} from "@capstan/schema";
import { venueHttp, VenueHttpError, type Governor, type VenueHttp } from "@capstan/venue-client";
import type { LighterConfig } from "./config";
import { docsSchedule, scheduleFromFeeTiers, tierFromName, type FeeSchedule, type LighterTier } from "./fees";
import { toMarkets, type LighterBookRaw, type LighterDetailRaw } from "./normalize";

/** Venue error code for "no account for this L1 address" (400 body {"code":21100}). */
export const LIGHTER_NO_ACCOUNT_CODE = 21100;
/** apikeys api_key_index=255 lists every key of the account. */
export const ALL_KEYS = 255;
/** Market metadata is re-read at most every 5 minutes. */
export const META_TTL_MS = 5 * 60_000;
/** Request weights from the rate-limits doc (Standard counts requests; kept for Plus and Builder accounts). */
export const LIGHTER_WEIGHTS = { nextNonce: 6, apikeys: 150, account: 300, other: 300 } as const;

/**
 * Funding `rate` unit: percent per hour. Golden test (test/funding.test.ts::hourly-and-unit) reproduces the docs
 * formula: with the premium inside the small clamp the rate is base_interest_rate / 8, and the venue publishes
 * 0.0100 / 8 = 0.00125 as "0.0012" on mainnet and 0.0032 / 8 = 0.0004 as "0.0004" on RH. Hourly fraction = rate / 100.
 */
export const FUNDING_RATE_UNIT = "percent_per_hour" as const;

export interface LighterApprovedIntegrator {
  accountIndex: number;
  name: string;
  maxPerpsTakerFee: number;
  maxPerpsMakerFee: number;
  maxSpotTakerFee: number;
  maxSpotMakerFee: number;
  approvalExpiry: number;
}

export interface LighterCollateralRow {
  symbol: string;
  assetId: number;
  balance: string; // venue units as published
  marginBalance: string;
  marginEnabled: boolean;
  /** The venue's own display multiplier for the asset, as published; never applied to any value here. */
  venueMultiplier: string;
}

export interface LighterAccountSnapshot extends AccountSnapshot {
  accountIndex: number;
  l1Address: Hex;
  collateral: LighterCollateralRow[];
  approvedIntegrators: LighterApprovedIntegrator[];
  totalOrderCount: number;
}

export interface LighterReader {
  readonly cfg: Readonly<LighterConfig>;
  health(): Promise<{ ok: boolean; networkId: number; ts: number }>;
  listMarkets(): Promise<Market[]>;
  getBook(marketId: string, depth?: number): Promise<OrderBook>;
  getFunding(marketId: string): Promise<FundingSnapshot>;
  accountIndexByL1(l1: Hex): Promise<{ main: number; subAccounts: number[] } | null>;
  getAccount(id: VenueIdentity): Promise<LighterAccountSnapshot>;
  getOpenOrders(id: VenueIdentity, opts?: { authToken?: string }): Promise<Order[]>;
  nextNonce(accountIndex: number, apiKeyIndex: number): Promise<number>;
  apiKeys(accountIndex: number): Promise<{ apiKeyIndex: number; publicKey: string }[]>;
  feeTier(accountIndex: number, opts?: { authToken?: string }): Promise<LighterTier>;
  feeSchedule(): Promise<FeeSchedule>;
  info(): Promise<{ contract: Hex; l1ChainId: number }>;
  tx(hash: string): Promise<{ found: boolean; status: number | null; raw: unknown }>;
  /** Market index of a market id of this config (loads the catalog once if needed). */
  marketIndex(marketId: string): Promise<number>;
  marketMeta(marketId: string): Promise<LighterMarketMeta>;
  streamMarket(marketIds: string[], onEvent: (e: MarketEvent) => void): Unsubscribe;
}

export interface LighterMarketMeta {
  market: Market;
  marketIndex: number;
  sizeDecimals: number;
  priceDecimals: number;
  minBaseAmount: string | null;
  markPx: string | null;
  imfTicks: number | null;
  capPerHour: string | null;
}

export type StreamFactory = (marketIds: string[], onEvent: (e: MarketEvent) => void) => Unsubscribe;

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : Number.NaN);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" ? String(v) : "0");
const iso = (ms: number) => new Date(ms).toISOString();

function requireInt(name: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new CapstanError("INVALID_INPUT", `${name} must be an integer in [${min}, ${max}]`);
  return v;
}

/** Percent per hour (venue) to a signed hourly fraction string. `direction: "short"` means shorts pay (negative). */
export function fundingFraction(ratePct: string, direction?: string): string {
  const d = Dec.parse(ratePct, 12, "half_even");
  const signed = direction === "short" ? Dec.neg(Dec.abs(d)) : d;
  return Dec.toString(Dec.div(signed, Dec.parse("100", 0), 12, "half_even"));
}

export function createLighterReader(cfg: Readonly<LighterConfig>, http: VenueHttp, cache: MarketDataCache | null, opts: { now?: () => number; stream?: StreamFactory } = {}): LighterReader {
  const now = opts.now ?? (() => Date.now());
  let meta: { at: number; byId: Map<string, LighterMarketMeta> } | null = null;
  let metaLoading: Promise<Map<string, LighterMarketMeta>> | null = null;

  const assertVenue = (id: VenueIdentity) => {
    if (id.venue !== cfg.venue) throw new CapstanError("INVALID_INPUT", `a ${id.venue} identity cannot be read on ${cfg.venue}`);
    if (id.accountIndex === undefined) throw new CapstanError("INVALID_INPUT", "a Lighter identity needs accountIndex");
    requireInt("accountIndex", id.accountIndex, 0, 2 ** 48 - 2);
  };
  const assertMarket = (marketId: string) => {
    if (!marketId.startsWith(`${cfg.venue}:`)) throw new CapstanError("INVALID_INPUT", `market ${marketId} is not on ${cfg.venue}`);
  };

  async function loadMeta(): Promise<Map<string, LighterMarketMeta>> {
    const [books, details] = await Promise.all([
      http.getJson<{ order_books: LighterBookRaw[] }>("/api/v1/orderBooks"),
      http.getJson<{ order_book_details?: LighterDetailRaw[]; spot_order_book_details?: LighterDetailRaw[] }>("/api/v1/orderBookDetails"),
    ]);
    const all = [...(details.order_book_details ?? []), ...(details.spot_order_book_details ?? [])];
    const byIndex = new Map(all.map((d) => [d.market_id, d]));
    const markets = toMarkets(cfg as LighterConfig, books.order_books ?? [], all, iso(now()));
    const byId = new Map<string, LighterMarketMeta>();
    for (const m of markets) {
      const d = byIndex.get(m.venueIndex as number);
      const b = (books.order_books ?? []).find((x) => x.market_id === m.venueIndex)!;
      const src = d ?? b;
      const big = d?.funding_clamp_big;
      byId.set(m.id, {
        market: m,
        marketIndex: m.venueIndex as number,
        sizeDecimals: (src.size_decimals ?? src.supported_size_decimals) as number,
        priceDecimals: (src.price_decimals ?? src.supported_price_decimals) as number,
        minBaseAmount: src.min_base_amount ?? null,
        markPx: d?.mark_price ?? null,
        imfTicks: typeof d?.default_initial_margin_fraction === "number" ? d.default_initial_margin_fraction : null,
        // funding_clamp_big is percent per 8 hours ("4.0000" = 4% per 8 h = 0.5% per hour)
        capPerHour: big ? Dec.toString(Dec.div(Dec.parse(big, 8, "half_even"), Dec.parse("800", 0), 10, "half_even")) : null,
      });
    }
    meta = { at: now(), byId };
    void cache?.putMeta(cfg.venue, markets);
    return byId;
  }

  async function metaMap(force = false): Promise<Map<string, LighterMarketMeta>> {
    if (!force && meta && now() - meta.at < META_TTL_MS) return meta.byId;
    if (!metaLoading) metaLoading = loadMeta().finally(() => (metaLoading = null));
    return metaLoading;
  }

  async function marketMeta(marketId: string): Promise<LighterMarketMeta> {
    assertMarket(marketId);
    const m = (await metaMap()).get(marketId);
    if (!m) throw new CapstanError("NOT_FOUND", `unknown market ${marketId}`);
    return m;
  }

  const reader: LighterReader = {
    cfg,
    async health() {
      // GET / (the documented status path answers 403 on both hosts)
      const r = await http.getJson<{ status?: number; network_id?: number; timestamp?: number }>("/");
      return { ok: r.status === 200, networkId: num(r.network_id), ts: num(r.timestamp) };
    },
    async listMarkets() {
      return [...(await metaMap(true)).values()].map((m) => m.market);
    },
    marketMeta,
    async marketIndex(marketId) {
      return (await marketMeta(marketId)).marketIndex;
    },
    async getBook(marketId, depth = 20) {
      const m = await marketMeta(marketId);
      const cached = await cache?.getBook(marketId);
      if (cached) return { ...cached, bids: cached.bids.slice(0, depth), asks: cached.asks.slice(0, depth) };
      const limit = Math.max(1, Math.min(250, depth * 5));
      const r = await http.getJson<{ asks?: { price: string; remaining_base_amount: string }[]; bids?: { price: string; remaining_base_amount: string }[] }>("/api/v1/orderBookOrders", { market_id: m.marketIndex, limit });
      return { marketId, bids: aggregate(r.bids ?? [], "desc").slice(0, depth), asks: aggregate(r.asks ?? [], "asc").slice(0, depth), asOf: iso(now()) };
    },
    async getFunding(marketId) {
      const m = await marketMeta(marketId);
      const end = Math.floor(now() / 1000);
      const r = await http.getJson<{ resolution?: string; fundings?: { timestamp: number; rate: string; direction?: string }[] }>("/api/v1/fundings", {
        market_id: m.marketIndex,
        resolution: "1h",
        start_timestamp: end - 6 * 3600,
        end_timestamp: end,
        count_back: 6,
      });
      const points = (r.fundings ?? []).slice().sort((a, b) => a.timestamp - b.timestamp);
      const last = points[points.length - 1];
      if (!last) throw new CapstanError("VENUE_ERROR", `no funding points for ${marketId}`);
      const perHour = fundingFraction(last.rate, last.direction);
      const signedPct = last.direction === "short" ? `-${last.rate.replace(/^-/, "")}` : last.rate;
      return {
        marketId,
        ratePerInterval: signedPct, // percent per hour, as published, signed by direction
        intervalS: 3600,
        ratePerHour: perHour,
        rateAnnualised: Dec.toString(Dec.mul(Dec.parse(perHour, 12), Dec.parse("8760", 0), 8, "half_even")),
        predictedNext: null,
        nextSettlementAt: iso((Math.floor(end / 3600) + 1) * 3600 * 1000),
        capPerHour: m.capPerHour,
        source: "venue",
        asOf: iso(last.timestamp * 1000),
      };
    },
    async accountIndexByL1(l1) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(l1)) throw new CapstanError("INVALID_INPUT", "l1 must be a 20-byte hex address");
      let r: { sub_accounts?: { index: number; account_type?: number }[] };
      try {
        r = await http.getJson("/api/v1/accountsByL1Address", { l1_address: l1 });
      } catch (e) {
        if (e instanceof VenueHttpError && e.httpStatus === 400 && (e.body as { code?: unknown } | null)?.code === LIGHTER_NO_ACCOUNT_CODE) return null;
        throw e;
      }
      const subs = (r.sub_accounts ?? []).filter((a) => Number.isSafeInteger(a.index));
      if (!subs.length) return null;
      const main = subs.find((a) => a.account_type === 0) ?? subs.slice().sort((a, b) => a.index - b.index)[0]!;
      return { main: main.index, subAccounts: subs.filter((a) => a.index !== main.index).map((a) => a.index) };
    },
    async getAccount(id) {
      assertVenue(id);
      const r = await http.getJson<{ accounts?: LighterAccountRaw[] }>("/api/v1/account", { by: "index", value: id.accountIndex! }, 1);
      const a = r.accounts?.[0];
      if (!a) throw new CapstanError("NOT_FOUND", `no ${cfg.venue} account ${id.accountIndex}`);
      if (a.l1_address.toLowerCase() !== id.owner.toLowerCase()) throw new CapstanError("INVALID_INPUT", `account ${id.accountIndex} on ${cfg.venue} belongs to another owner`);
      return accountSnapshot(cfg, id, a, iso(now()));
    },
    async getOpenOrders(id, o = {}) {
      assertVenue(id);
      if (!o.authToken) throw new CapstanError("UNAUTHORIZED", "Lighter open orders need an auth token made by the owner's API key (createAuthToken)");
      const acct = await reader.getAccount(id);
      const out: Order[] = [];
      const metaById = await metaMap();
      const byIndex = new Map([...metaById.values()].map((m) => [m.marketIndex, m.market.id]));
      const markets = new Set<number>();
      for (const p of acct.positions) {
        const mm = metaById.get(p.marketId);
        if (mm) markets.add(mm.marketIndex);
      }
      for (const mi of markets) {
        const r = await http.getJson<{ orders?: LighterOrderRaw[] }>("/api/v1/accountActiveOrders", { account_index: id.accountIndex!, market_id: mi, auth: o.authToken });
        for (const raw of r.orders ?? []) out.push(orderFromRaw(cfg, raw, byIndex.get(raw.market_index) ?? `${cfg.venue}:-:${raw.market_index}`));
      }
      return out;
    },
    async nextNonce(accountIndex, apiKeyIndex) {
      requireInt("accountIndex", accountIndex, 0, 2 ** 48 - 2);
      requireInt("apiKeyIndex", apiKeyIndex, 0, 254);
      const r = await http.getJson<{ nonce?: number }>("/api/v1/nextNonce", { account_index: accountIndex, api_key_index: apiKeyIndex }, 1);
      return requireInt("nonce", r.nonce, 0, 2 ** 48 - 1);
    },
    async apiKeys(accountIndex) {
      requireInt("accountIndex", accountIndex, 0, 2 ** 48 - 2);
      const r = await http.getJson<{ api_keys?: { api_key_index: number; public_key: string }[] }>("/api/v1/apikeys", { account_index: accountIndex, api_key_index: ALL_KEYS }, 1);
      return (r.api_keys ?? []).map((k) => ({ apiKeyIndex: k.api_key_index, publicKey: String(k.public_key).replace(/^0x/i, "").toLowerCase() }));
    },
    async feeTier(accountIndex, o = {}) {
      requireInt("accountIndex", accountIndex, 0, 2 ** 48 - 2);
      // keyless reads cannot see the tier; quotes then use Standard (the base tier)
      if (!o.authToken) return "standard";
      const r = await http.getJson<{ user_tier_name?: string }>("/api/v1/accountLimits", { account_index: accountIndex, auth: o.authToken });
      return tierFromName(r.user_tier_name) ?? "standard";
    },
    async feeSchedule() {
      try {
        return scheduleFromFeeTiers(cfg.venue, await http.getJson("/api/v1/feeTiers"));
      } catch (e) {
        // RH answers 403 from CloudFront: the docs table is the source (tierSource 'docs')
        if (e instanceof VenueHttpError && e.httpStatus === 403) return docsSchedule(cfg.venue);
        throw e;
      }
    },
    async info() {
      // /info answers { contract_address } only; the L1 chain travels with the config
      const r = await http.getJson<{ contract_address?: string }>("/info");
      const contract = String(r.contract_address ?? "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new CapstanError("VENUE_ERROR", `${cfg.venue} /info has no contract address`);
      return { contract: contract as Hex, l1ChainId: cfg.l1ChainId };
    },
    async tx(hash) {
      if (!/^(0x)?[0-9a-fA-F]{16,128}$/.test(hash)) throw new CapstanError("INVALID_INPUT", "tx hash must be hex");
      try {
        const r = await http.getJson<{ status?: number; hash?: string }>("/api/v1/tx", { by: "hash", value: hash });
        return { found: true, status: typeof r.status === "number" ? r.status : null, raw: r };
      } catch (e) {
        if (e instanceof VenueHttpError && e.httpStatus >= 400 && e.httpStatus < 500) return { found: false, status: null, raw: e.body };
        throw e;
      }
    },
    streamMarket(marketIds, onEvent) {
      for (const id of marketIds) assertMarket(id);
      if (!opts.stream) throw new CapstanError("INTERNAL_ERROR", "this reader was made without a stream (use createLighterIngest)");
      return opts.stream(marketIds, onEvent);
    },
  };
  return reader;
}

function aggregate(levels: { price: string; remaining_base_amount: string }[], order: "asc" | "desc"): [string, string][] {
  const m = new Map<string, ReturnType<typeof Dec.parse>>();
  for (const l of levels) {
    const sz = Dec.parse(l.remaining_base_amount, 12, "down");
    const prev = m.get(l.price);
    m.set(l.price, prev ? Dec.add(prev, sz) : sz);
  }
  const rows = [...m.entries()].map(([px, sz]) => [px, Dec.toString(sz)] as [string, string]);
  rows.sort((a, b) => Dec.cmp(Dec.parse(a[0], 12, "half_even"), Dec.parse(b[0], 12, "half_even")) * (order === "asc" ? 1 : -1));
  return rows;
}

export interface LighterAccountRaw {
  index: number;
  account_index?: number;
  l1_address: string;
  available_balance?: string;
  collateral?: string;
  total_asset_value?: string;
  total_order_count?: number;
  positions?: {
    market_id: number;
    symbol: string;
    initial_margin_fraction?: string;
    open_order_count?: number;
    sign: number;
    position: string;
    avg_entry_price: string;
    position_value: string;
    unrealized_pnl: string;
    liquidation_price?: string;
    margin_mode?: number;
  }[];
  assets?: { symbol: string; asset_id: number; balance: string; margin_balance?: string; margin_mode?: string; multiplier?: string }[];
  approved_integrators?: { account_index: number; name: string; max_perps_taker_fee: number; max_perps_maker_fee: number; max_spot_taker_fee: number; max_spot_maker_fee: number; approval_expiry: number }[];
}

/** Venue account to a snapshot. Every value is the venue's own number: no multiplier is applied to anything. */
export function accountSnapshot(cfg: Readonly<LighterConfig>, id: VenueIdentity, a: LighterAccountRaw, asOf: string): LighterAccountSnapshot {
  const positions: Position[] = [];
  for (const p of a.positions ?? []) {
    const size = Dec.parse(str(p.position), 12, "down");
    if (Dec.isZero(size)) continue;
    const value = Dec.abs(Dec.parse(str(p.position_value), 12, "half_even"));
    const imf = Number(p.initial_margin_fraction ?? "0");
    const liq = str(p.liquidation_price ?? "0");
    positions.push({
      venue: cfg.venue,
      marketId: `${cfg.venue}:-:${p.symbol}`,
      canonicalAsset: null,
      side: p.sign < 0 ? "short" : "long",
      size: Dec.toString(Dec.abs(size)),
      entryPx: str(p.avg_entry_price),
      markPx: Dec.toString(Dec.div(value, Dec.abs(size), 8, "half_even")),
      notionalUsd: Dec.toString(value),
      leverage: imf > 0 ? Math.max(1, Math.round(100 / imf)) : 1,
      marginMode: p.margin_mode === 1 ? "isolated" : "cross",
      liqPx: liq === "0" || liq === "" ? null : liq,
      liqPxSource: "venue",
      marginRatio: null,
      unrealisedPnlUsd: str(p.unrealized_pnl),
      collateralAsset: cfg.collateral,
      asOf,
    });
  }
  return {
    venue: cfg.venue,
    identity: id,
    equityUsd: str(a.total_asset_value ?? a.collateral ?? "0"),
    freeCollateralUsd: str(a.available_balance ?? "0"),
    positions,
    asOf,
    accountIndex: a.account_index ?? a.index,
    l1Address: a.l1_address as Hex,
    collateral: (a.assets ?? [])
      .filter((x) => x.margin_mode === "enabled")
      .map((x) => ({ symbol: x.symbol, assetId: x.asset_id, balance: str(x.balance), marginBalance: str(x.margin_balance ?? "0"), marginEnabled: true, venueMultiplier: str(x.multiplier ?? "1") })),
    approvedIntegrators: (a.approved_integrators ?? []).map((g) => ({
      accountIndex: g.account_index,
      name: g.name,
      maxPerpsTakerFee: g.max_perps_taker_fee,
      maxPerpsMakerFee: g.max_perps_maker_fee,
      maxSpotTakerFee: g.max_spot_taker_fee,
      maxSpotMakerFee: g.max_spot_maker_fee,
      approvalExpiry: g.approval_expiry,
    })),
    totalOrderCount: a.total_order_count ?? 0,
  };
}

export interface LighterOrderRaw {
  order_index: number | string;
  order_id?: string;
  client_order_index?: number | string;
  market_index: number;
  initial_base_amount: string;
  remaining_base_amount?: string;
  filled_base_amount?: string;
  price: string;
  is_ask: boolean;
  status: string;
  timestamp?: number;
  integrator_taker_fee?: string;
}

function orderFromRaw(cfg: Readonly<LighterConfig>, o: LighterOrderRaw, marketId: string): Order {
  const st = o.status;
  const filled = str(o.filled_base_amount ?? "0");
  const status: Order["status"] =
    st === "filled" ? "filled" : st.startsWith("canceled") ? "cancelled" : st === "open" || st === "pending" || st === "in-progress" ? (Dec.isZero(Dec.parse(filled, 12, "down")) ? "open" : "partial") : "open";
  return {
    venue: cfg.venue,
    marketId,
    venueOrderId: String(o.order_id ?? o.order_index),
    ...(o.client_order_index !== undefined ? { clientOrderId: String(o.client_order_index) } : {}),
    side: o.is_ask ? "sell" : "buy",
    size: str(o.initial_base_amount),
    filled,
    px: o.price ?? null,
    status,
    builderFeeBps: 0,
    createdAt: iso((o.timestamp ?? 0) * 1000),
  };
}

/** A reader on the shared governor for one config (REST at the config's 1 req/s budget, free-tier priority). */
export function lighterReaderFor(cfg: Readonly<LighterConfig>, gov: Governor, cache: MarketDataCache | null, opts: { fetchImpl?: typeof fetch; rest?: string; stream?: StreamFactory; now?: () => number } = {}): LighterReader {
  const http = venueHttp(cfg.governorKey, opts.rest ?? cfg.rest, gov, { userAgent: "capstan-lighter", ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  return createLighterReader(cfg, http, cache, { ...(opts.stream ? { stream: opts.stream } : {}), ...(opts.now ? { now: opts.now } : {}) });
}
