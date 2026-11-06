// Hyperliquid read adapter, core + HIP-3 (spec 4.1, 4.2; venue-hyperliquid.md sections 2 to 5, 8). Every call goes
// through the governed VenueHttp with its info weight. Queries always use the MASTER address: the venue answers an
// agent address with an empty account, so an agent address is refused before any call.
import type { MarketDataCache } from "@capstan/core";
import { CapstanError, type FundingSnapshot, type Hex, type MarketEvent, type Order, type OrderBook, type Unsubscribe, type VenueIdentity } from "@capstan/schema";
import { hlInfoWeight, venueWs, VenueHttpError, type VenueHttp, type VenueKey, type VenueWs } from "@capstan/venue-client";
import { collateralFor, parseMarketId, parsePerpDexs, type HlAssetCtx, type HlDex, type HlMeta, type HlMetaAndAssetCtxs, type HlPerpDexRaw } from "./meta";
import {
  HL_CORE_FUNDING_CAP_PER_HOUR,
  nextHourIso,
  normalizeFunding,
  toAccountSnapshot,
  toBook,
  toDexAccount,
  toMarket,
  toOrder,
  type HlAccountSnapshot,
  type HlClearinghouseState,
  type HlDexAccount,
  type HlL2Book,
  type HlMarket,
  type HlOpenOrder,
} from "./normalize";

export interface HlConfig {
  network: "Mainnet" | "Testnet";
  infoUrl: string;
  exchangeUrl: string;
  wsUrl: string;
  builderAddress: Hex | null;
}

export const HL_MAINNET: Omit<HlConfig, "builderAddress"> = {
  network: "Mainnet",
  infoUrl: "https://api.hyperliquid.xyz/info",
  exchangeUrl: "https://api.hyperliquid.xyz/exchange",
  wsUrl: "wss://api.hyperliquid.xyz/ws",
};
export const HL_TESTNET: Omit<HlConfig, "builderAddress"> = {
  network: "Testnet",
  infoUrl: "https://api.hyperliquid-testnet.xyz/info",
  exchangeUrl: "https://api.hyperliquid-testnet.xyz/exchange",
  wsUrl: "wss://api.hyperliquid-testnet.xyz/ws",
};

export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  startPosition?: string;
  dir?: string;
  closedPnl?: string;
  hash?: string;
  oid: number | string;
  crossed?: boolean;
  fee: string;
  tid?: number | string;
  cloid?: Hex | null;
  feeToken?: string;
  builderFee?: string;
  twapId?: unknown;
}

export interface HlExtraAgent {
  name: string;
  address: Hex;
  validUntil: number | null;
}

export interface HlReader {
  perpDexs(): Promise<HlDex[]>;
  listMarkets(): Promise<HlMarket[]>;
  getBook(marketId: string, depth?: number): Promise<OrderBook>;
  getFunding(marketId: string): Promise<FundingSnapshot>;
  getAccount(id: VenueIdentity): Promise<HlAccountSnapshot>;
  getOpenOrders(id: VenueIdentity): Promise<Order[]>;
  maxBuilderFee(user: Hex, builder: Hex): Promise<number>;
  approvedBuilders(user: Hex): Promise<Hex[]>;
  extraAgents(user: Hex): Promise<HlExtraAgent[]>;
  perpDexLimits(dex: string): Promise<{ totalOiCap: string; coinToOiCap: Record<string, string> }>;
  userRateLimit(user: Hex): Promise<{ cumVlm: string; nRequestsUsed: number; nRequestsCap: number }>;
  userFills(user: Hex, startMs: number, endMs?: number): Promise<HlFill[]>;
  streamMarket(marketIds: string[], onEvent: (e: MarketEvent) => void): Unsubscribe;
  // Additions the order path (todos 07, 08) and the ingest job use.
  metaAndAssetCtxs(dex: string | null): Promise<HlMetaAndAssetCtxs>;
  /** The market with its precision inputs, from meta read at most 10 minutes ago. */
  instrument(marketId: string): Promise<HlMarket>;
  /** Raw clearinghouseState for one dex (null = core) of the master address. */
  dexAccount(owner: Hex, dex: string | null): Promise<HlDexAccount>;
  userFees(user: Hex): Promise<HlUserFees>;
  /** Dexes queried for account reads: core plus every dex with at least one listed market. */
  accountDexes(): Promise<(string | null)[]>;
}

export interface HlUserFees {
  userCrossRate: string; // taker, decimal (0.00045 = 4.5 bps)
  userAddRate: string; // maker
  feeSchedule?: { cross: string; add: string };
  [k: string]: unknown;
}

export interface HlReaderOptions {
  now?: () => number;
  /** Known agent addresses (the delegations table); an owner listed here is refused. */
  isKnownAgent?: (address: Hex) => boolean | Promise<boolean>;
  /** WebSocket pool for streamMarket; built from cfg.wsUrl when absent. */
  ws?: VenueWs;
  /** Meta (precision) refresh period; the spec says 10 minutes. */
  metaTtlMs?: number;
}

export const META_TTL_MS = 10 * 60 * 1000;
export const UNKNOWN_INFO_TYPE_TEXT = "Failed to deserialize the JSON body into the target type";

/** Raised for an info `type` the venue does not know (plain-text 422), never mistaken for an empty list. */
export class HlUnknownInfoType extends CapstanError {
  readonly venueCode = "UNKNOWN_INFO_TYPE" as const;
  readonly infoType: string;
  constructor(infoType: string) {
    super("VENUE_ERROR", `hyperliquid: unknown info type ${infoType}`);
    this.infoType = infoType;
  }
}

export const HL_WS_LIMITS = { maxConns: 10, maxNewPerMin: 30, maxSubs: 1000, pingMs: 50_000 } as const;

const isAddr = (a: unknown): a is Hex => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

function venueKeyOf(cfg: HlConfig): VenueKey {
  return cfg.network === "Mainnet" ? "hyperliquid" : "hyperliquid-testnet";
}

export function hlWs(cfg: HlConfig, opts: Partial<{ maxConns: number; maxNewPerMin: number; maxSubs: number; pingMs: number }> & { newConnWindowMs?: number; backoffBaseMs?: number; onError?: (e: unknown) => void } = {}): VenueWs {
  return venueWs(venueKeyOf(cfg), cfg.wsUrl, {
    ...HL_WS_LIMITS,
    ...opts,
    pingMessage: { method: "ping" },
    unsubscribeMessage: (m) => ({ ...(m as Record<string, unknown>), method: "unsubscribe" }),
  });
}

export function createHlReader(cfg: HlConfig, http: VenueHttp, cache: MarketDataCache, opts: HlReaderOptions = {}): HlReader {
  const now = opts.now ?? Date.now;
  const metaTtl = opts.metaTtlMs ?? META_TTL_MS;
  const knownAgents = new Set<string>();
  let ws = opts.ws ?? null;
  type MetaState = { at: number; dexes: HlDex[]; markets: Map<string, HlMarket> };
  let state: MetaState | null = null;
  let loading: Promise<MetaState> | null = null;

  async function info<T>(body: Record<string, unknown>): Promise<T> {
    const type = String(body.type);
    let res: unknown;
    try {
      res = await http.postJson<unknown>("/info", body, hlInfoWeight(type));
    } catch (e) {
      if (e instanceof VenueHttpError && typeof e.body === "string" && e.body.includes(UNKNOWN_INFO_TYPE_TEXT)) throw new HlUnknownInfoType(type);
      throw e;
    }
    if (typeof res === "string" && res.includes(UNKNOWN_INFO_TYPE_TEXT)) throw new HlUnknownInfoType(type);
    return res as T;
  }

  const user = (u: Hex) => {
    if (!isAddr(u)) throw new CapstanError("INVALID_INPUT", "hyperliquid: user must be a 20-byte address");
    return u.toLowerCase() as Hex;
  };

  async function assertMaster(owner: Hex): Promise<Hex> {
    const o = user(owner);
    if (knownAgents.has(o) || (opts.isKnownAgent && (await opts.isKnownAgent(o)))) {
      throw new CapstanError("INVALID_INPUT", "hyperliquid: account reads take the master address, not an agent address");
    }
    return o;
  }

  async function perpDexs(): Promise<HlDex[]> {
    return parsePerpDexs(await info<(HlPerpDexRaw | null)[]>({ type: "perpDexs" }));
  }

  async function metaAndAssetCtxs(dex: string | null): Promise<HlMetaAndAssetCtxs> {
    const r = await info<HlMetaAndAssetCtxs>(dex === null ? { type: "metaAndAssetCtxs" } : { type: "metaAndAssetCtxs", dex });
    if (!Array.isArray(r) || r.length !== 2 || !Array.isArray(r[0]?.universe)) throw new CapstanError("VENUE_ERROR", `hyperliquid: metaAndAssetCtxs(${dex ?? "core"}) has an unexpected shape`);
    return r;
  }

  async function perpDexLimits(dex: string) {
    const r = await info<{ totalOiCap: string; coinToOiCap: [string, string][] | Record<string, string> }>({ type: "perpDexLimits", dex });
    const coinToOiCap: Record<string, string> = Array.isArray(r.coinToOiCap) ? Object.fromEntries(r.coinToOiCap.map(([c, v]) => [c, String(v)])) : { ...(r.coinToOiCap ?? {}) };
    return { totalOiCap: String(r.totalOiCap), coinToOiCap };
  }

  async function listMarkets(): Promise<HlMarket[]> {
    const t = new Date(now());
    const dexes = await perpDexs();
    const out: HlMarket[] = [];
    for (const dex of dexes) {
      const [meta, ctxs] = await metaAndAssetCtxs(dex.name);
      const live = meta.universe.some((u) => !u.isDelisted);
      const limits = dex.name !== null && live ? await perpDexLimits(dex.name) : null;
      meta.universe.forEach((entry, i) => {
        out.push(toMarket({ entry, indexInMeta: i, dex, collateralToken: meta.collateralToken, ctx: ctxs[i] ?? null, oiCapUsd: limits?.coinToOiCap[entry.name] ?? null, now: t }));
      });
    }
    state = { at: now(), dexes, markets: new Map(out.map((m) => [m.id, m])) };
    await cache.putMeta("hyperliquid", { at: state.at, dexes: dexes.map((d) => ({ index: d.index, name: d.name })), markets: out.length });
    return out;
  }

  async function ensureState(): Promise<MetaState> {
    if (state && now() - state.at < metaTtl) return state;
    if (!loading) {
      loading = (async (): Promise<MetaState> => {
        await listMarkets();
        return state as unknown as MetaState;
      })().finally(() => {
        loading = null;
      });
    }
    return loading;
  }

  async function instrument(id: string): Promise<HlMarket> {
    const s = await ensureState();
    const m = s.markets.get(id);
    if (!m) throw new CapstanError("NOT_FOUND", `hyperliquid: unknown market ${id}`);
    return m;
  }

  async function getBook(id: string, depth?: number): Promise<OrderBook> {
    const { coin } = parseMarketId(id);
    const raw = await info<HlL2Book>({ type: "l2Book", coin });
    if (!raw || typeof raw !== "object") throw new CapstanError("VENUE_ERROR", `hyperliquid: no book for ${coin}`);
    // A stale book is returned with its real asOf: the quote engine refuses it, not the adapter.
    return toBook(id, raw, depth);
  }

  async function getFunding(id: string): Promise<FundingSnapshot> {
    const { dex, coin } = parseMarketId(id);
    const t = now();
    const asOf = new Date(t).toISOString();
    if (dex === null) {
      const rows = await info<[string, [string, { fundingRate: string; nextFundingTime: number; fundingIntervalHours?: number } | null][]][]>({ type: "predictedFundings" });
      const row = rows.find((r) => r[0] === coin);
      const hl = row?.[1].find((v) => v[0] === "HlPerp")?.[1];
      if (!hl) throw new CapstanError("NOT_FOUND", `hyperliquid: no HlPerp predicted funding for ${coin}`);
      const hours = hl.fundingIntervalHours ?? 1;
      if (hours !== 1) throw new CapstanError("VENUE_ERROR", `hyperliquid: funding interval ${hours} h, expected 1 h`);
      const snap: FundingSnapshot = {
        marketId: id,
        ...normalizeFunding(hl.fundingRate),
        predictedNext: hl.fundingRate,
        nextSettlementAt: new Date(Number(hl.nextFundingTime)).toISOString(),
        capPerHour: HL_CORE_FUNDING_CAP_PER_HOUR,
        source: "venue",
        asOf,
      };
      await cache.putFunding(snap);
      return snap;
    }
    const [[meta, ctxs], dexes] = await Promise.all([metaAndAssetCtxs(dex), perpDexs()]);
    const i = meta.universe.findIndex((u) => u.name === coin);
    const ctx: HlAssetCtx | undefined = ctxs[i];
    if (i < 0 || !ctx) throw new CapstanError("NOT_FOUND", `hyperliquid: no funding for ${coin}`);
    const d = dexes.find((x) => x.name === dex);
    const snap: FundingSnapshot = {
      marketId: id,
      ...normalizeFunding(ctx.funding),
      predictedNext: null,
      nextSettlementAt: nextHourIso(t),
      capPerHour: d?.fundingClamp[coin] ?? null,
      source: "venue",
      asOf,
    };
    await cache.putFunding(snap);
    return snap;
  }

  async function accountDexes(): Promise<(string | null)[]> {
    const s = await ensureState();
    const withMarkets = new Set<string>();
    for (const m of s.markets.values()) if (m.dex !== null && m.status !== "delisted") withMarkets.add(m.dex);
    return [null, ...s.dexes.filter((d) => d.name !== null && withMarkets.has(d.name)).map((d) => d.name)];
  }

  async function dexAccount(owner: Hex, dex: string | null): Promise<HlDexAccount> {
    const o = await assertMaster(owner);
    const s = await ensureState();
    const raw = await info<HlClearinghouseState>(dex === null ? { type: "clearinghouseState", user: o } : { type: "clearinghouseState", user: o, dex });
    const sample = [...s.markets.values()].find((m) => m.dex === dex);
    const coll = sample?.collateralAsset ?? collateralFor(0).asset;
    return toDexAccount(dex, coll, raw);
  }

  async function getAccount(id: VenueIdentity): Promise<HlAccountSnapshot> {
    if (id.venue !== "hyperliquid") throw new CapstanError("UNSUPPORTED_VENUE");
    const o = await assertMaster(id.owner);
    if (id.agentAddress && id.agentAddress.toLowerCase() === o) throw new CapstanError("INVALID_INPUT", "hyperliquid: owner equals the agent address");
    const perDex: HlDexAccount[] = [];
    for (const dex of await accountDexes()) perDex.push(await dexAccount(o, dex));
    return toAccountSnapshot({ ...id, owner: o }, perDex, new Date(now()).toISOString());
  }

  async function getOpenOrders(id: VenueIdentity): Promise<Order[]> {
    const o = await assertMaster(id.owner);
    const out: Order[] = [];
    for (const dex of await accountDexes()) {
      const rows = await info<HlOpenOrder[]>(dex === null ? { type: "frontendOpenOrders", user: o } : { type: "frontendOpenOrders", user: o, dex });
      for (const r of rows ?? []) out.push(toOrder(dex, r));
    }
    return out;
  }

  async function maxBuilderFee(u: Hex, builder: Hex): Promise<number> {
    const r = await info<unknown>({ type: "maxBuilderFee", user: user(u), builder: user(builder) });
    const n = typeof r === "string" ? Number(r) : r;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new CapstanError("VENUE_ERROR", "hyperliquid: maxBuilderFee is not a non-negative integer");
    return n;
  }

  async function approvedBuilders(u: Hex): Promise<Hex[]> {
    const r = await info<unknown>({ type: "approvedBuilders", user: user(u) });
    if (!Array.isArray(r)) throw new CapstanError("VENUE_ERROR", "hyperliquid: approvedBuilders is not a list");
    return r.filter(isAddr).map((a) => a.toLowerCase() as Hex);
  }

  async function extraAgents(u: Hex): Promise<HlExtraAgent[]> {
    const r = await info<{ name: string; address: Hex; validUntil?: number | null }[]>({ type: "extraAgents", user: user(u) });
    if (!Array.isArray(r)) throw new CapstanError("VENUE_ERROR", "hyperliquid: extraAgents is not a list");
    const out = r.filter((a) => isAddr(a.address)).map((a) => ({ name: String(a.name ?? ""), address: a.address.toLowerCase() as Hex, validUntil: typeof a.validUntil === "number" ? a.validUntil : null }));
    for (const a of out) knownAgents.add(a.address);
    return out;
  }

  async function userRateLimit(u: Hex) {
    const r = await info<{ cumVlm: string; nRequestsUsed: number; nRequestsCap: number }>({ type: "userRateLimit", user: user(u) });
    return { cumVlm: String(r.cumVlm), nRequestsUsed: Number(r.nRequestsUsed), nRequestsCap: Number(r.nRequestsCap) };
  }

  async function userFills(u: Hex, startMs: number, endMs?: number): Promise<HlFill[]> {
    const body: Record<string, unknown> = { type: "userFillsByTime", user: await assertMaster(u), startTime: startMs };
    if (endMs !== undefined) body.endTime = endMs;
    const r = await info<HlFill[]>(body);
    if (!Array.isArray(r)) throw new CapstanError("VENUE_ERROR", "hyperliquid: userFillsByTime is not a list");
    return r;
  }

  async function userFees(u: Hex): Promise<HlUserFees> {
    return info<HlUserFees>({ type: "userFees", user: await assertMaster(u) });
  }

  function streamMarket(marketIds: string[], onEvent: (e: MarketEvent) => void): Unsubscribe {
    if (!ws) ws = hlWs(cfg);
    const pool = ws;
    const byCoin = new Map<string, string>();
    const dexes = new Set<string>();
    for (const id of marketIds) {
      const { dex, coin } = parseMarketId(id);
      byCoin.set(coin, id);
      dexes.add(dex ?? "");
    }
    const unsubs: Unsubscribe[] = [];
    const onMsg = (m: unknown) => {
      const msg = m as { channel?: string; data?: unknown };
      if (msg?.channel === "l2Book") {
        const b = msg.data as HlL2Book;
        const id = byCoin.get(b?.coin);
        if (id) onEvent({ kind: "book", book: toBook(id, b) });
      } else if (msg?.channel === "allMids") {
        const mids = (msg.data as { mids?: Record<string, string> })?.mids ?? {};
        const asOf = new Date(now()).toISOString();
        for (const [coin, px] of Object.entries(mids)) {
          const id = byCoin.get(coin);
          if (id) onEvent({ kind: "mark", marketId: id, mark: String(px), asOf });
        }
      }
    };
    for (const coin of byCoin.keys()) unsubs.push(pool.subscribe({ method: "subscribe", subscription: { type: "l2Book", coin } }, onMsg));
    for (const dex of dexes) unsubs.push(pool.subscribe({ method: "subscribe", subscription: dex ? { type: "allMids", dex } : { type: "allMids" } }, onMsg));
    return () => {
      for (const u of unsubs) u();
    };
  }

  return {
    perpDexs,
    listMarkets,
    getBook,
    getFunding,
    getAccount,
    getOpenOrders,
    maxBuilderFee,
    approvedBuilders,
    extraAgents,
    perpDexLimits,
    userRateLimit,
    userFills,
    streamMarket,
    metaAndAssetCtxs,
    instrument,
    dexAccount,
    userFees,
    accountDexes,
  };
}

