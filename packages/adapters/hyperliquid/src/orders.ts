// Order, cancel and close-all builds (spec 2, 4.1, 7.3; venue-hyperliquid.md 3, 5 to 8). The server builds the exact
// L1 action, the nonce, the 30 s expiresAfter and the advisory digest; the SDK recomputes the digest and signs with the
// agent key. Every core order carries the builder field {b: pinned builder, f: 20} (f: 10 for the lock tier).
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import { ulid, type MarketDataCache } from "@capstan/core";
import { CapstanError, Dec, type BuildContext, type CancelIntent, type FundingSnapshot, type Hex, type OrderBook, type OrderIntent, type OrderPreview, type UnsignedVenuePayload, type VenueIdentity } from "@capstan/schema";
import { assertNonceWindow, formatPrice, formatSize, l1Digest, toHex, type HlBuilder, type HlCancelAction, type HlCancelByCloidAction, type HlL1Action, type HlNetwork, type HlOrderAction, type HlOrderWire } from "@capstan/signer-hl";
import type { HlMarket } from "./normalize";
import { absStr } from "./normalize";
import { HL_BASE_FEES, midOf, protectiveLimit, quote, type HlFeeTier } from "./quote";
import type { HlConfig, HlReader } from "./read";

export const BUILD_LIFE_MS = 30_000;
export const BOOK_MAX_AGE_MS = 3_000; // DECISIONS #29
export const MAX_BUILDER_FEE_CACHE_MS = 60_000;
export const USER_FEES_CACHE_MS = 10 * 60_000;
export const HL_MAX_OPEN_ORDERS_FOR_REDUCE_ONLY = 1000;
export const CLOSE_ALL_DEFAULT_SLIPPAGE_BPS = 200;
export const HL_CHARGE_TENTHS_BP = 20;
export const HL_LOCK_TIER_TENTHS_BP = 10;

export function sha256Jcs(v: unknown): Hex {
  const s = canonicalize(v);
  if (s === undefined) throw new CapstanError("INTERNAL_ERROR", "not JSON");
  return toHex(sha256(utf8ToBytes(s)));
}

/** Per-agent nonce: ms timestamp, strictly increasing within the process, inside (T - 2 d, T + 1 d). */
export class NonceSource {
  private readonly last = new Map<string, number>();
  next(agent: string, nowMs: number): number {
    const k = agent.toLowerCase();
    const v = Math.max(nowMs, (this.last.get(k) ?? 0) + 1);
    assertNonceWindow(v, nowMs);
    this.last.set(k, v);
    return v;
  }
}

export type AgentState = "active" | "retired" | "killed";

export interface HlBuildContext extends BuildContext {
  agentState?: AgentState;
  mode?: "relay" | "direct";
  requestHash?: Hex;
  feeTier?: HlFeeTier;
  /** Slippage for close-all protective prices. */
  closeAllSlippageBps?: number;
}

export interface HlOrderPayload {
  action: HlL1Action;
  nonce: number;
  vaultAddress: null;
  expiresAfter: number;
}

export interface HlOrderPreview extends OrderPreview {
  avgFillPx: string | null;
  limitPx: string;
  fundingCostBps: number;
  totalCostBps: number;
  filledSize: string;
  quoteStatus: "ok" | "insufficient_depth";
}

export interface HlBuildMeta {
  owner: Hex;
  agentRef: string;
  agentAddress: Hex | null;
  network: HlNetwork;
  marketId: string;
  policyId: string | null;
  requestHash: Hex;
  builder: HlBuilder | null;
  quoteSnapshotHash: Hex;
  kind: "order" | "cancel" | "close";
}

export interface HlUnsignedPayload extends UnsignedVenuePayload {
  encoding: "hl_l1_action";
  payload: HlOrderPayload;
  preview: HlOrderPreview;
  meta: HlBuildMeta;
  /** Direct mode: the SDK posts this body itself, with its signature filled in. */
  direct?: { postUrl: string; body: { action: HlL1Action; nonce: number; signature: "<signature>"; vaultAddress: null; expiresAfter: number } };
}

/** HIP-3 order rules (todo 08). Without one, every opening HIP-3 build is MARKET_NOT_EXECUTABLE. */
export interface Hip3Hook {
  prepare(m: HlMarket, intent: OrderIntent, ctx: HlBuildContext): Promise<{ builderOn: boolean; feeTier: HlFeeTier; warnings?: string[] }>;
}

export interface HlBuildDeps {
  cfg: HlConfig & { builderAddress: Hex | null };
  reader: HlReader;
  cache: MarketDataCache;
  nonces: NonceSource;
  now?: () => number;
  /** Ops pause per venue (DECISIONS #7). Default: HL_ENABLED != "0". */
  enabled?: () => boolean;
  /** Catalog executability (todo 03). When given, a non-executable market cannot open a position. */
  isExecutable?: (marketId: string) => boolean | Promise<boolean>;
  hip3?: Hip3Hook;
}

const CLOID = /^0x[0-9a-fA-F]{32}$/;

function assertEnabled(d: HlBuildDeps): void {
  const on = d.enabled ? d.enabled() : process.env.HL_ENABLED !== "0";
  if (!on) throw new CapstanError("VENUE_ERROR", "Hyperliquid is paused");
}

function assertAgent(ctx: HlBuildContext): Hex {
  if (ctx.agentState === "retired") throw new CapstanError("RETIRED_AGENT");
  if (ctx.agentState === "killed") throw new CapstanError("AGENT_KILLED");
  const a = ctx.identity?.agentAddress;
  if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new CapstanError("INVALID_INPUT", "the build needs the delegation's agent address");
  return a.toLowerCase() as Hex;
}

const approvedCache = new WeakMap<HlReader, Map<string, { v: number; at: number }>>();
const feesCache = new WeakMap<HlReader, Map<string, { v: HlFeeTier; at: number }>>();

/** maxBuilderFee for (owner, builder), cached 60 s; unreadable = BUILDER_APPROVAL_REQUIRED (fail closed). */
export async function approvedTenthsBp(reader: HlReader, owner: Hex, builder: Hex, nowMs: number): Promise<number> {
  let m = approvedCache.get(reader);
  if (!m) approvedCache.set(reader, (m = new Map()));
  const k = `${owner.toLowerCase()}:${builder.toLowerCase()}`;
  const hit = m.get(k);
  if (hit && nowMs - hit.at < MAX_BUILDER_FEE_CACHE_MS) return hit.v;
  let v: number;
  try {
    v = await reader.maxBuilderFee(owner, builder);
  } catch {
    throw new CapstanError("BUILDER_APPROVAL_REQUIRED", "The builder approval could not be read from Hyperliquid. Try again shortly.");
  }
  m.set(k, { v, at: nowMs });
  return v;
}

export async function ownerFees(reader: HlReader, owner: Hex, nowMs: number): Promise<HlFeeTier> {
  let m = feesCache.get(reader);
  if (!m) feesCache.set(reader, (m = new Map()));
  const hit = m.get(owner);
  if (hit && nowMs - hit.at < USER_FEES_CACHE_MS) return hit.v;
  try {
    const f = await reader.userFees(owner);
    const v: HlFeeTier = /^\d+(\.\d+)?$/.test(String(f.userCrossRate)) ? { takerRate: String(f.userCrossRate), makerRate: String(f.userAddRate), source: "user" } : HL_BASE_FEES;
    m.set(owner, { v, at: nowMs });
    return v;
  } catch {
    return HL_BASE_FEES;
  }
}

/**
 * The builder field for this build. f is 20 (2 bps) or 10 (lock tier) and must be within the main wallet's approval
 * (tenths of a bp). No approval at all = FEE_FREE_UNAVAILABLE: no Hyperliquid order is built for that owner.
 */
export function builderField(ctx: BuildContext, builder: Hex | null, approvedTenths: number): HlBuilder {
  if (!builder) throw new CapstanError("FEE_FREE_UNAVAILABLE", "The Hyperliquid builder is not configured.");
  const f = ctx.builderFee?.tenthsBp ?? HL_CHARGE_TENTHS_BP;
  if (f !== HL_CHARGE_TENTHS_BP && f !== HL_LOCK_TIER_TENTHS_BP) throw new CapstanError("INVALID_INPUT", "builder f must be 20 or 10 tenths of a bp");
  const ctxMax = ctx.approvedMaxBps === null || ctx.approvedMaxBps === undefined ? Number.POSITIVE_INFINITY : Math.round(ctx.approvedMaxBps * 10);
  const approved = Math.min(approvedTenths, ctxMax);
  if (!(approved > 0)) throw new CapstanError("FEE_FREE_UNAVAILABLE", "This account has not approved the Capstan builder fee on Hyperliquid.");
  if (f > approved) throw new CapstanError("BUILDER_APPROVAL_REQUIRED", `The builder approval is ${approved / 10} bps; this order needs ${f / 10} bps. Onboard again to approve 0.03%.`);
  return { b: builder.toLowerCase() as Hex, f };
}

async function freshBook(d: HlBuildDeps, id: string, now: number): Promise<OrderBook> {
  const b = (await d.cache.getBook(id)) ?? (await d.reader.getBook(id));
  if (now - Date.parse(b.asOf) > BOOK_MAX_AGE_MS) throw new CapstanError("STALE_QUOTE", `The ${id} book is ${now - Date.parse(b.asOf)} ms old.`);
  return b;
}

async function refPrice(d: HlBuildDeps, id: string, book: OrderBook, now: number): Promise<string> {
  const m = await d.cache.getMark(id);
  if (m && now - Date.parse(m.asOf) <= BOOK_MAX_AGE_MS) return m.mark;
  const mid = midOf(book);
  if (!mid) throw new CapstanError("STALE_QUOTE", `No two-sided book for ${id}.`);
  return mid;
}

async function fundingFor(d: HlBuildDeps, id: string): Promise<FundingSnapshot | null> {
  try {
    return (await d.cache.getFunding(id)) ?? (await d.reader.getFunding(id));
  } catch {
    return null;
  }
}

const TIF = { ioc: "Ioc", gtc: "Gtc", alo: "Alo" } as const;

interface WireSpec {
  side: "buy" | "sell";
  size: string;
  type: "market" | "limit";
  limitPx?: string;
  tif: "ioc" | "gtc" | "alo";
  reduceOnly: boolean;
  cloid?: string;
  maxSlippageBps: number;
  leverage?: number;
}

function newCloid(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** Build one order: the shared path of buildOrder and close-all. */
async function buildOne(d: HlBuildDeps, m: HlMarket, spec: WireSpec, ctx: HlBuildContext, opts: { builderOn: boolean; feeTier?: HlFeeTier; warnings?: string[]; kind: "order" | "close" }): Promise<HlUnsignedPayload> {
  const now = ctx.nowMs ?? (d.now ?? Date.now)();
  const agent = assertAgent(ctx);
  if (spec.side !== "buy" && spec.side !== "sell") throw new CapstanError("INVALID_INPUT", "side must be buy or sell");
  if (!(spec.tif in TIF)) throw new CapstanError("INVALID_INPUT", "tif must be ioc, gtc or alo");
  if (!Number.isFinite(spec.maxSlippageBps) || spec.maxSlippageBps < 0 || spec.maxSlippageBps > 5000) throw new CapstanError("INVALID_INPUT", "maxSlippageBps must be 0 to 5000");
  if (spec.cloid !== undefined && !CLOID.test(spec.cloid)) throw new CapstanError("INVALID_INPUT", "clientOrderId must be 0x + 32 hex characters");
  const warnings = [...(opts.warnings ?? [])];

  let builder: HlBuilder | null = null;
  if (opts.builderOn) {
    if (!d.cfg.builderAddress) throw new CapstanError("FEE_FREE_UNAVAILABLE", "The Hyperliquid builder is not configured.");
    builder = builderField(ctx, d.cfg.builderAddress, await approvedTenthsBp(d.reader, ctx.owner, d.cfg.builderAddress, now));
  }

  const book = await freshBook(d, m.id, now);
  const ref = await refPrice(d, m.id, book, now);
  let size: string;
  try {
    size = formatSize(spec.size, m.szDecimals);
  } catch (e) {
    throw new CapstanError("INVALID_INPUT", (e as Error).message);
  }
  if (size !== spec.size.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")) warnings.push(`size rounded down to ${size}`);
  // Never worse than the user's bound: buys round the limit DOWN, sells UP.
  const dir = spec.side === "buy" ? "down" : "up";
  const rawLimit = spec.type === "limit" ? spec.limitPx : protectiveLimit(ref, spec.side, spec.maxSlippageBps);
  if (!rawLimit || !/^\d+(\.\d+)?$/.test(rawLimit)) throw new CapstanError("INVALID_INPUT", "a limit order needs limitPx");
  let limit: string;
  try {
    limit = formatPrice(rawLimit, m.szDecimals, dir);
  } catch (e) {
    throw new CapstanError("INVALID_INPUT", (e as Error).message);
  }
  const tif = spec.type === "market" ? "Ioc" : TIF[spec.tif];
  const wire: HlOrderWire = { a: m.assetId, b: spec.side === "buy", p: limit, s: size, r: spec.reduceOnly, t: { limit: { tif } }, c: (spec.cloid?.toLowerCase() as Hex | undefined) ?? newCloid() };
  const action: HlOrderAction = builder ? { type: "order", orders: [wire], grouping: "na", builder } : { type: "order", orders: [wire], grouping: "na" };
  const nonce = d.nonces.next(agent, now);
  const expiresAfter = now + BUILD_LIFE_MS;

  const fees = opts.feeTier ?? ctx.feeTier ?? (await ownerFees(d.reader, ctx.owner, now));
  const feeTier = tif === "Alo" ? { ...fees, takerRate: fees.makerRate } : fees;
  const funding = await fundingFor(d, m.id);
  // the preview walks the same book at the BUILT limit and size: quote == execution
  const q = quote(
    { marketId: m.id, side: spec.side, sizeBase: size, leverage: spec.leverage ?? 1, holdHours: 1, orderType: "limit", limitPx: limit, builderTenthsBp: builder?.f ?? 0, collateralAsset: m.collateralAsset, maxLeverage: m.maxLeverage, refPx: ref, nowMs: now },
    book,
    feeTier,
    funding,
  );
  if (q.status !== "ok") warnings.push(`insufficient_depth: the book fills ${q.filledSize} of ${size} at the limit`);
  if (q.estLiqPx) warnings.push("estLiqPx is computed, not venue-reported");
  // a buy's part the visible book does not fill is priced at the built limit, where it fills deeper or rests (security
  // r2 D2-ADP-07, review-r1:7 F7): policy caps compare this notional, never the partial average over the whole size
  const notionalUsd = notionalOf(spec.side, size, q.filledSize, q.avgFillPx, limit);
  const preview: HlOrderPreview = {
    marketId: m.id,
    side: spec.side,
    size,
    px: limit,
    notionalUsd,
    venueFeeBps: q.venueFeeBps,
    builderFeeBps: builder ? builder.f / 10 : 0,
    builderFee: builder ? { address: builder.b, rawUnit: `f=${builder.f}` } : null,
    slippageBps: q.slippageBps,
    estLiqPx: q.estLiqPx,
    collateralAsset: m.collateralAsset,
    reduceOnly: spec.reduceOnly,
    warnings,
    avgFillPx: q.status === "ok" ? q.avgFillPx : null,
    limitPx: limit,
    fundingCostBps: q.fundingCostBps,
    totalCostBps: q.totalCostBps,
    filledSize: q.filledSize,
    quoteStatus: q.status === "ok" ? "ok" : "insufficient_depth",
  };
  const payload: HlOrderPayload = { action, nonce, vaultAddress: null, expiresAfter };
  const out: HlUnsignedPayload = {
    buildId: ulid(now),
    venue: "hyperliquid",
    signer: "delegated_key",
    encoding: "hl_l1_action",
    payload,
    digest: l1Digest(action, null, nonce, d.cfg.network, expiresAfter),
    preview,
    expiresAt: expiresAfter,
    eligibilityDecisionId: ctx.eligibilityDecisionId,
    meta: {
      owner: ctx.owner.toLowerCase() as Hex,
      agentRef: ctx.agentRef,
      agentAddress: agent,
      network: d.cfg.network,
      marketId: m.id,
      policyId: ctx.policyId,
      requestHash: ctx.requestHash ?? sha256Jcs({ marketId: m.id, ...spec }),
      builder,
      quoteSnapshotHash: sha256Jcs({ preview, book: { asOf: book.asOf, bids: book.bids.slice(0, 20), asks: book.asks.slice(0, 20) } }),
      kind: opts.kind,
    },
  };
  if (ctx.mode === "direct") out.direct = { postUrl: d.cfg.exchangeUrl, body: { action, nonce, signature: "<signature>", vaultAddress: null, expiresAfter } };
  return out;
}

const decimals = (x: string) => (x.includes(".") ? x.length - x.indexOf(".") - 1 : 0);
const trimDec = (x: string) => (x.includes(".") ? x.replace(/0+$/, "").replace(/\.$/, "") : x);

/**
 * Preview notional (D2-ADP-07): a buy's filled part at its walk average plus the rest at the built limit (it fills
 * deeper up to the limit or rests there). A sell's remainder fills below the visible average, so the average over the
 * whole size stays its upper bound.
 */
export function notionalOf(side: "buy" | "sell", size: string, filled: string | null | undefined, avg: string | null | undefined, limit: string): string {
  if (!avg || avg === "0" || !filled || Dec.isZero(Dec.parse(filled, decimals(filled)))) return mulStrSafe(size, limit);
  if (side === "sell") return mulStrSafe(size, avg);
  const sc = Math.max(decimals(size), decimals(filled));
  const rest = Dec.sub(Dec.parse(size, sc), Dec.parse(filled, sc));
  if (Dec.cmp(rest, Dec.parse("0", sc)) <= 0) return mulStrSafe(size, avg);
  const x = mulStrSafe(filled, avg);
  const y = mulStrSafe(trimDec(Dec.toString(rest)), limit);
  const out = Math.max(decimals(x), decimals(y));
  return trimDec(Dec.toString(Dec.add(Dec.parse(x, out), Dec.parse(y, out))));
}

function mulStrSafe(a: string, b: string): string {
  const da = a.includes(".") ? a.length - a.indexOf(".") - 1 : 0;
  const db = b.includes(".") ? b.length - b.indexOf(".") - 1 : 0;
  const ai = BigInt(a.replace(".", ""));
  const bi = BigInt(b.replace(".", ""));
  const v = (ai * bi).toString().padStart(da + db + 1, "0");
  const sc = da + db;
  const s = sc ? `${v.slice(0, v.length - sc)}.${v.slice(v.length - sc)}` : v;
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export async function buildOrder(intent: OrderIntent, ctx: HlBuildContext, d: HlBuildDeps): Promise<HlUnsignedPayload> {
  assertEnabled(d);
  assertAgent(ctx);
  if (!intent || typeof intent.marketId !== "string") throw new CapstanError("INVALID_INPUT", "marketId is required");
  const m = await d.reader.instrument(intent.marketId);
  if (m.status === "delisted") throw new CapstanError("MARKET_NOT_EXECUTABLE", `${m.id} is delisted`);
  if (m.status === "reduce_only" && !intent.reduceOnly) throw new CapstanError("MARKET_NOT_EXECUTABLE", `${m.id} is reduce-only: only closing orders are accepted`);
  if (m.marketType !== "perp") throw new CapstanError("MARKET_NOT_EXECUTABLE");
  if (m.collateralAsset.startsWith("TOKEN:")) throw new CapstanError("MARKET_NOT_EXECUTABLE", `${m.id} uses an unknown collateral token`);
  let builderOn = true;
  let feeTier: HlFeeTier | undefined;
  let warnings: string[] | undefined;
  if (m.dex !== null) {
    if (!d.hip3) throw new CapstanError("MARKET_NOT_EXECUTABLE", "HIP-3 markets are not executable yet");
    const h = await d.hip3.prepare(m, intent, ctx);
    builderOn = h.builderOn;
    feeTier = h.feeTier;
    warnings = h.warnings;
  } else if (d.isExecutable && !intent.reduceOnly && !(await d.isExecutable(m.id))) {
    throw new CapstanError("MARKET_NOT_EXECUTABLE", `${m.id} is not executable`);
  }
  return buildOne(d, m, { side: intent.side, size: intent.size, type: intent.type, limitPx: intent.limitPx, tif: intent.tif, reduceOnly: intent.reduceOnly, cloid: intent.clientOrderId, maxSlippageBps: intent.maxSlippageBps, leverage: intent.leverage }, ctx, { builderOn, feeTier, warnings, kind: "order" });
}

function cancelPreview(marketId: string, m: HlMarket, warnings: string[]): HlOrderPreview {
  return { marketId, side: "buy", size: "0", px: null, notionalUsd: "0", venueFeeBps: 0, builderFeeBps: 0, builderFee: null, slippageBps: 0, estLiqPx: null, collateralAsset: m.collateralAsset, reduceOnly: true, warnings, avgFillPx: null, limitPx: "0", fundingCostBps: 0, totalCostBps: 0, filledSize: "0", quoteStatus: "ok" };
}

async function cancelPayload(d: HlBuildDeps, m: HlMarket, action: HlCancelAction | HlCancelByCloidAction, ctx: HlBuildContext, label: string): Promise<HlUnsignedPayload> {
  const now = ctx.nowMs ?? (d.now ?? Date.now)();
  const agent = assertAgent(ctx);
  const nonce = d.nonces.next(agent, now);
  const expiresAfter = now + BUILD_LIFE_MS;
  const preview = cancelPreview(m.id, m, [label]);
  const out: HlUnsignedPayload = {
    buildId: ulid(now),
    venue: "hyperliquid",
    signer: "delegated_key",
    encoding: "hl_l1_action",
    payload: { action, nonce, vaultAddress: null, expiresAfter },
    digest: l1Digest(action, null, nonce, d.cfg.network, expiresAfter),
    preview,
    expiresAt: expiresAfter,
    eligibilityDecisionId: ctx.eligibilityDecisionId,
    meta: { owner: ctx.owner.toLowerCase() as Hex, agentRef: ctx.agentRef, agentAddress: agent, network: d.cfg.network, marketId: m.id, policyId: ctx.policyId, requestHash: ctx.requestHash ?? sha256Jcs(action), builder: null, quoteSnapshotHash: sha256Jcs(preview), kind: "cancel" },
  };
  if (ctx.mode === "direct") out.direct = { postUrl: d.cfg.exchangeUrl, body: { action, nonce, signature: "<signature>", vaultAddress: null, expiresAfter } };
  return out;
}

function oidNumber(oid: string): number {
  if (!/^\d{1,16}$/.test(oid) || !Number.isSafeInteger(Number(oid))) throw new CapstanError("INVALID_INPUT", "venueOrderId must be a safe integer");
  return Number(oid);
}

/** Cancel by oid or by cloid. Cancels carry no builder field. */
export async function buildCancel(req: CancelIntent, ctx: HlBuildContext, d: HlBuildDeps): Promise<HlUnsignedPayload> {
  assertEnabled(d);
  const m = await d.reader.instrument(req.marketId);
  let action: HlCancelAction | HlCancelByCloidAction;
  if (req.venueOrderId !== undefined) action = { type: "cancel", cancels: [{ a: m.assetId, o: oidNumber(req.venueOrderId) }] };
  else if (req.clientOrderId !== undefined) {
    if (!CLOID.test(req.clientOrderId)) throw new CapstanError("INVALID_INPUT", "clientOrderId must be 0x + 32 hex characters");
    action = { type: "cancelByCloid", cancels: [{ asset: m.assetId, cloid: req.clientOrderId.toLowerCase() as Hex }] };
  } else throw new CapstanError("INVALID_INPUT", "a cancel needs venueOrderId or clientOrderId");
  return cancelPayload(d, m, action, ctx, "cancel");
}

/**
 * Close everything: per dex, one reduce-only IOC per open position sized to the full position (opposite side, never
 * opening anything). Above 1,000 open orders the venue rejects reduce-only orders, so that dex's list starts with a
 * cancel of its open orders. Close orders still carry the builder field.
 */
export async function buildCloseAll(id: VenueIdentity, ctx: HlBuildContext, d: HlBuildDeps): Promise<HlUnsignedPayload[]> {
  assertEnabled(d);
  assertAgent(ctx);
  const acct = await d.reader.getAccount(id);
  // a dex that left perpDexs and no longer answers: its positions are unknown, so never return a silent partial list
  if (acct.unreadableDexes?.length) {
    const names = acct.unreadableDexes.map((u) => u.dex).join(", ");
    throw new CapstanError("VENUE_ERROR", `hyperliquid close-all: the ${names} dex left perpDexs and its account could not be read, so positions there cannot be closed from here. Close them on Hyperliquid directly.`);
  }
  const gone = new Set((await d.reader.goneDexes()).map((g) => g.dex.name));
  const open = await d.reader.getOpenOrders(id);
  const slip = ctx.closeAllSlippageBps ?? CLOSE_ALL_DEFAULT_SLIPPAGE_BPS;
  const out: HlUnsignedPayload[] = [];
  for (const dexAcct of acct.perDex) {
    const dexOrders = open.filter((o) => o.marketId.startsWith(`hyperliquid:${dexAcct.dex ?? "-"}:`));
    if (dexOrders.length > HL_MAX_OPEN_ORDERS_FOR_REDUCE_ONLY && dexAcct.positions.length > 0) {
      const cancels: { a: number; o: number }[] = [];
      for (const o of dexOrders) cancels.push({ a: (await d.reader.instrument(o.marketId)).assetId, o: oidNumber(o.venueOrderId) });
      const m0 = await d.reader.instrument(dexOrders[0]!.marketId);
      out.push(await cancelPayload(d, m0, { type: "cancel", cancels }, ctx, `cancel ${cancels.length} open orders before reduce-only closes`));
    }
    for (const p of dexAcct.positions) {
      const m = await d.reader.instrument(p.marketId);
      const side = p.side === "long" ? "sell" : "buy";
      let builderOn = true;
      let feeTier: HlFeeTier | undefined;
      const intent: OrderIntent = { marketId: m.id, side, size: absStr(p.size), type: "market", tif: "ioc", reduceOnly: true, maxSlippageBps: slip };
      if (m.dex !== null && d.hip3) {
        const h = await d.hip3.prepare(m, intent, ctx);
        builderOn = h.builderOn;
        feeTier = h.feeTier;
      }
      const warnings = m.dex !== null && gone.has(m.dex) ? ["close-all", `${m.dex} left perpDexs: reduce-only close from the last-known market`] : ["close-all"];
      try {
        out.push(await buildOne(d, m, { side, size: absStr(p.size), type: "market", tif: "ioc", reduceOnly: true, maxSlippageBps: slip }, ctx, { builderOn, feeTier, kind: "close", warnings }));
      } catch (e) {
        if (m.dex === null || !gone.has(m.dex)) throw e;
        throw new CapstanError("VENUE_ERROR", `hyperliquid close-all: ${m.id} on the ${m.dex} dex (gone from perpDexs) could not be built: ${(e as Error).message}`);
      }
    }
  }
  return out;
}

