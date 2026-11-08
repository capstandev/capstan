// checkBuild (spec 7.3 step 3, threat model "servers fully compromised"): before anything is signed, every field of a
// server-built payload is compared with the user's intent, the pins and independent venue facts, and the digest the
// key will sign is recomputed here. Any difference refuses with the field named. The server's preview is display
// only and is checked for consistency, never trusted.
import type { AgentPolicy, CancelIntent, Hex, OrderIntent, UnsignedVenuePayload, VenueId } from "@capstan/schema";
import { digestTrade, queryString, type Param } from "@capstan/signer-aster";
import { formatPrice, formatSize, l1Digest, type HlL1Action, type HlOrderAction, type HlOrderWire } from "@capstan/signer-hl";
import { eqAddr } from "./bytes";
import { bound, cmp, eqDec, fromUnits, isDec, mul, toUnits } from "./dec";
import type { VenueMarketSpec } from "./markets";
import type { Network, Pins } from "./pins";
import { checkPolicy, type PolicyChecker } from "./policy";

export type CheckCode = "PAYLOAD_MISMATCH" | "BUILD_EXPIRED" | "POLICY_BREACH";
export type CheckResult = { ok: true; digest: Hex } | { ok: false; code: CheckCode; field: string };

export interface CheckIdentity {
  owner?: Hex;
  agentAddress?: Hex; // HL agent / Aster signer (the local key's address)
  accountIndex?: number; // Lighter
  apiKeyIndex?: number; // Lighter
}

export interface CheckContext {
  venue: VenueId;
  /** The builder fee ceiling the main wallet approved, in bps (HL "0.03%" = 3). null: no approval, no fee allowed. */
  approvedMax: number | null;
  pins: Pins;
  policy?: AgentPolicy;
  nowMs: number;
  network?: Network;
  /** Independent market facts from the venue (asset id, decimals). Required for HL and Lighter. */
  market?: VenueMarketSpec;
  /** Independent reference price for market orders. Required for market orders. */
  refPx?: string | null;
  /** Allowance for drift between the venue's reference and ours, on top of maxSlippageBps. Default 25 bps. */
  refTolBps?: number;
  /**
   * Set for an intent read from the payload itself (close-all, kill, signer.sign without a user intent): its price is
   * also bounded by refPx within this many bps (plus refTolBps), since its own limit came from the same server
   * (security r1, review-r1:1 F1). refPx is then required.
   */
  refBoundBps?: number;
  identity?: CheckIdentity;
  /** Inputs the policy check needs beyond the intent. */
  policyInput?: { agentRef: string; grossNotionalUsd: string; ordersToday: number; mode: "relay" | "direct" };
  policyChecker?: PolicyChecker;
}

export const MAX_BUILD_LIFE_MS = 60_000;
export const DEFAULT_REF_TOL_BPS = 25;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

class Refusal {
  constructor(
    readonly code: CheckCode,
    readonly field: string,
  ) {}
}
const no = (field: string, code: CheckCode = "PAYLOAD_MISMATCH"): never => {
  throw new Refusal(code, field);
};
const sameKeys = (o: object, allowed: string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));

function common(intent: OrderIntent | null, b: UnsignedVenuePayload, ctx: CheckContext, encoding: UnsignedVenuePayload["encoding"]): void {
  if (!b || typeof b !== "object") no("build");
  if (b.venue !== ctx.venue) no("venue");
  if (b.encoding !== encoding) no("encoding");
  if (b.signer !== "delegated_key") no("signer");
  if (typeof b.expiresAt !== "number" || ctx.nowMs > b.expiresAt) no("expiresAt", "BUILD_EXPIRED");
  if (b.expiresAt - ctx.nowMs > MAX_BUILD_LIFE_MS) no("expiresAt");
  if (typeof b.digest !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.digest)) no("digest");
  if (intent && b.preview) {
    const p = b.preview;
    if (p.marketId !== intent.marketId) no("preview.marketId");
    if (p.side !== intent.side) no("preview.side");
    if (p.reduceOnly !== intent.reduceOnly) no("preview.reduceOnly");
  }
}

function validIntent(i: OrderIntent): void {
  if (!i || typeof i.marketId !== "string") no("intent.marketId");
  if (i.side !== "buy" && i.side !== "sell") no("intent.side");
  if (!isDec(i.size) || cmp(i.size, "0") <= 0) no("intent.size");
  if (i.type !== "market" && i.type !== "limit") no("intent.type");
  if (i.type === "limit" && (!i.limitPx || !isDec(i.limitPx) || cmp(i.limitPx, "0") <= 0)) no("intent.limitPx");
  if (!["ioc", "gtc", "alo"].includes(i.tif)) no("intent.tif");
  if (typeof i.reduceOnly !== "boolean") no("intent.reduceOnly");
  if (!Number.isFinite(i.maxSlippageBps) || i.maxSlippageBps < 0 || i.maxSlippageBps > 5000) no("intent.maxSlippageBps");
}

/** The price bound a market order may not cross, from an independent reference. */
function marketBound(intent: OrderIntent, ctx: CheckContext): string {
  const ref = ctx.refPx;
  if (!ref || !isDec(ref) || cmp(ref, "0") <= 0) no("price");
  return bound(ref!, intent.maxSlippageBps + (ctx.refTolBps ?? DEFAULT_REF_TOL_BPS), intent.side);
}

function priceWithin(px: string, intent: OrderIntent, ctx: CheckContext): void {
  if (!isDec(px) || cmp(px, "0") <= 0) no("price");
  const lim = intent.type === "limit" ? intent.limitPx! : marketBound(intent, ctx);
  // never worse than the user's bound: a buy pays at most, a sell receives at least
  if (intent.side === "buy" ? cmp(px, lim) > 0 : cmp(px, lim) < 0) no("price");
  if (ctx.refBoundBps !== undefined) {
    // a derived intent's limit is the server's own price: bound it by the independent reference as well
    const refLim = marketBound({ ...intent, maxSlippageBps: ctx.refBoundBps }, ctx);
    if (intent.side === "buy" ? cmp(px, refLim) > 0 : cmp(px, refLim) < 0) no("price");
  }
}

function runPolicy(intent: OrderIntent, notionalUsd: string, ctx: CheckContext): void {
  if (!ctx.policy) return;
  const pi = ctx.policyInput;
  if (!pi) no("policy", "POLICY_BREACH");
  const r = (ctx.policyChecker ?? checkPolicy)({
    policy: ctx.policy,
    agentRef: pi!.agentRef,
    venue: ctx.venue,
    marketId: intent.marketId,
    side: intent.side,
    notionalUsd,
    leverage: intent.leverage ?? 1,
    reduceOnly: intent.reduceOnly,
    grossNotionalUsd: pi!.grossNotionalUsd,
    ordersToday: pi!.ordersToday,
    nowMs: ctx.nowMs,
    mode: pi!.mode,
  });
  if (!r.ok) no(String(r.field), "POLICY_BREACH");
}

// ---------------------------------------------------------------- Hyperliquid
const HL_TIF = { ioc: "Ioc", gtc: "Gtc", alo: "Alo" } as const;
interface HlPayload {
  action: HlL1Action;
  nonce: number;
  vaultAddress: null;
  expiresAfter: number;
}

function hlCommon(b: UnsignedVenuePayload, ctx: CheckContext): HlPayload {
  const p = b.payload as HlPayload;
  if (!p || typeof p !== "object" || !p.action || typeof p.action !== "object") no("payload");
  if (!sameKeys(p, ["action", "nonce", "vaultAddress", "expiresAfter"])) no("payload.keys");
  if (p.vaultAddress !== null) no("vaultAddress");
  if (!Number.isSafeInteger(p.nonce) || p.nonce <= 0) no("nonce");
  // HL refuses nonces outside (T - 2 d, T + 1 d); ours are ms timestamps close to now
  if (Math.abs(p.nonce - ctx.nowMs) > 5 * 60_000) no("nonce");
  if (p.expiresAfter !== b.expiresAt) no("expiresAfter");
  return p;
}

function hlDigest(p: HlPayload, b: UnsignedVenuePayload, ctx: CheckContext): Hex {
  const net = ctx.pins.networks[ctx.network ?? "mainnet"].hlNetwork;
  let d: Hex;
  try {
    d = l1Digest(p.action, null, p.nonce, net, p.expiresAfter);
  } catch {
    return no("action");
  }
  if (d.toLowerCase() !== b.digest.toLowerCase()) no("digest");
  return d;
}

function hlBuilder(a: HlOrderAction, ctx: CheckContext): void {
  if (a.builder === undefined) return; // no fee at all: never against the user
  const bld = a.builder;
  if (!bld || typeof bld !== "object" || !sameKeys(bld, ["b", "f"])) no("builder");
  const pin = ctx.pins.networks[ctx.network ?? "mainnet"].builders.hyperliquid;
  if (!pin || !eqAddr(bld.b, pin)) no("builder.address");
  const allowed = ctx.pins.networks[ctx.network ?? "mainnet"].allowedFees.hyperliquid;
  if (!Number.isInteger(bld.f) || !allowed.includes(bld.f)) no("builder.fee");
  if (ctx.approvedMax === null || bld.f / 10 > ctx.approvedMax) no("builder.fee");
}

function checkHl(intent: OrderIntent, b: UnsignedVenuePayload, ctx: CheckContext): { digest: Hex; notional: string } {
  common(intent, b, ctx, "hl_l1_action");
  const m = ctx.market;
  if (!m || m.venue !== "hyperliquid" || m.marketId !== intent.marketId) no("market");
  const spec = m as Extract<VenueMarketSpec, { venue: "hyperliquid" }>;
  const p = hlCommon(b, ctx);
  const a = p.action as HlOrderAction;
  if (a.type !== "order") no("type");
  if (!sameKeys(a, ["type", "orders", "grouping", "builder"])) no("action.keys");
  if (a.grouping !== "na") no("grouping");
  if (!Array.isArray(a.orders) || a.orders.length !== 1) no("orders");
  const o = a.orders[0] as HlOrderWire;
  if (!sameKeys(o, ["a", "b", "p", "s", "r", "t", "c"])) no("orders.keys");
  if (o.a !== spec.assetId) no("market");
  if (o.b !== (intent.side === "buy")) no("side");
  let size: string;
  try {
    size = formatSize(intent.size, spec.szDecimals);
  } catch {
    return no("size");
  }
  if (typeof o.s !== "string" || o.s !== size) no("size");
  if (typeof o.p !== "string") no("price");
  if (intent.type === "limit") {
    let want: string;
    try {
      want = formatPrice(intent.limitPx!, spec.szDecimals, intent.side === "buy" ? "down" : "up");
    } catch {
      return no("price");
    }
    if (!eqDec(o.p, want)) no("price");
  }
  priceWithin(o.p, intent, ctx);
  if (o.r !== intent.reduceOnly) no("reduceOnly");
  const tif = intent.type === "market" ? "Ioc" : HL_TIF[intent.tif];
  const t = o.t as { limit?: { tif?: string } };
  if (!t || typeof t !== "object" || !sameKeys(t, ["limit"]) || !t.limit || !sameKeys(t.limit, ["tif"]) || t.limit.tif !== tif) no("tif");
  if (intent.clientOrderId !== undefined && String(o.c ?? "").toLowerCase() !== intent.clientOrderId.toLowerCase()) no("clientOrderId");
  if (o.c !== undefined && !/^0x[0-9a-fA-F]{32}$/.test(String(o.c))) no("clientOrderId");
  hlBuilder(a, ctx);
  return { digest: hlDigest(p, b, ctx), notional: mul(size, o.p) };
}

// ---------------------------------------------------------------- Lighter
const LIGHTER_ORDER_KEYS = ["marketIndex", "clientOrderIndex", "baseAmount", "price", "isAsk", "orderType", "timeInForce", "reduceOnly", "triggerPrice", "orderExpiry", "integratorAccountIndex", "integratorTakerFee", "integratorMakerFee", "selfTradeBehaviorMode", "selfTradeEqualityMode", "nonce", "apiKeyIndex", "accountIndex", "expiredAt"];
const LIGHTER_TX_EXPIRY_MAX_MS = 10 * 60_000 + 30_000;

function lighterAccount(args: { accountIndex: number; apiKeyIndex: number }, ctx: CheckContext): void {
  const id = ctx.identity;
  if (!id || id.accountIndex === undefined || id.apiKeyIndex === undefined) no("account");
  if (args.accountIndex !== id!.accountIndex) no("account");
  if (args.apiKeyIndex !== id!.apiKeyIndex) no("apiKeyIndex");
}

function lighterExpiry(expiredAt: number, ctx: CheckContext): void {
  if (!Number.isSafeInteger(expiredAt) || expiredAt <= ctx.nowMs || expiredAt - ctx.nowMs > LIGHTER_TX_EXPIRY_MAX_MS) no("expiredAt");
}

function checkLighter(intent: OrderIntent, b: UnsignedVenuePayload, ctx: CheckContext): { digest: Hex; notional: string } {
  common(intent, b, ctx, "lighter_tx");
  const m = ctx.market;
  if (!m || m.venue !== ctx.venue || (m.venue !== "lighter-mainnet" && m.venue !== "lighter-rh") || m.marketId !== intent.marketId) no("market");
  const spec = m as Extract<VenueMarketSpec, { venue: "lighter-mainnet" | "lighter-rh" }>;
  const p = b.payload as { txType: number; args: Record<string, unknown> };
  if (!p || typeof p !== "object" || !sameKeys(p, ["txType", "args"])) no("payload");
  if (p.txType !== 14) no("txType");
  const a = p.args as Record<string, number | boolean>;
  if (!a || typeof a !== "object" || !sameKeys(a, LIGHTER_ORDER_KEYS)) no("args.keys");
  if (a.marketIndex !== spec.marketIndex) no("market");
  if (a.isAsk !== (intent.side === "sell")) no("side");
  const units = toUnits(intent.size, spec.sizeDecimals, "down");
  if (units <= 0n || a.baseAmount !== Number(units)) no("size");
  if (!Number.isSafeInteger(a.price) || (a.price as number) < 1) no("price");
  const px = fromUnits(a.price as number, spec.priceDecimals);
  if (intent.type === "limit") {
    const want = toUnits(intent.limitPx!, spec.priceDecimals, intent.side === "buy" ? "down" : "up");
    if (BigInt(a.price as number) !== want) no("price");
  }
  priceWithin(px, intent, ctx);
  if (a.reduceOnly !== intent.reduceOnly) no("reduceOnly");
  if (a.orderType !== (intent.type === "market" ? 1 : 0)) no("type");
  const tif = intent.tif === "ioc" ? 0 : intent.tif === "alo" ? 2 : 1;
  if (a.timeInForce !== tif) no("tif");
  if (a.triggerPrice !== 0) no("triggerPrice");
  if (a.integratorTakerFee !== 0 || a.integratorMakerFee !== 0) no("builder.fee");
  const integ = ctx.pins.networks[ctx.network ?? "mainnet"].lighterIntegratorIndex[ctx.venue as "lighter-mainnet" | "lighter-rh"];
  if (a.integratorAccountIndex !== (integ ?? 0)) no("builder.address");
  if (a.selfTradeBehaviorMode !== 0 || a.selfTradeEqualityMode !== 0) no("selfTrade");
  if (!Number.isSafeInteger(a.nonce) || (a.nonce as number) < 0) no("nonce");
  if (!Number.isSafeInteger(a.clientOrderIndex) || (a.clientOrderIndex as number) < 1 || (a.clientOrderIndex as number) > 2 ** 48 - 1) no("clientOrderId");
  if (intent.clientOrderId !== undefined && String(a.clientOrderIndex) !== intent.clientOrderId) no("clientOrderId");
  lighterAccount(a as unknown as { accountIndex: number; apiKeyIndex: number }, ctx);
  lighterExpiry(a.expiredAt as number, ctx);
  // the txHash is recomputed by the local WASM signer at sign time and compared with b.digest (signer.ts)
  return { digest: b.digest, notional: mul(fromUnits(units, spec.sizeDecimals), px) };
}

// ---------------------------------------------------------------- Aster
const ASTER_TIF = { gtc: "GTC", ioc: "IOC", alo: "GTX" } as const;
const ASTER_CLIENT_ID = /^[A-Za-z0-9_.:/-]{1,36}$/;

function asterChain(ctx: CheckContext): { name: "Mainnet" | "Testnet"; chainId: 1666 | 714 } {
  const name = ctx.pins.networks[ctx.network ?? "mainnet"].asterNetwork;
  return { name, chainId: name === "Testnet" ? 714 : 1666 };
}

function checkAster(intent: OrderIntent, b: UnsignedVenuePayload, ctx: CheckContext): { digest: Hex; notional: string } {
  common(intent, b, ctx, "aster_v3_params");
  const p = b.payload as { method: string; path: string; chainId: number; params: Param[]; signer: Hex; clientOrderId: string | null; kind: string };
  if (!p || typeof p !== "object" || !sameKeys(p, ["method", "path", "chainId", "params", "signer", "clientOrderId", "kind"])) no("payload");
  if (p.method !== "POST" || p.path !== "/fapi/v3/order" || p.kind !== "order") no("path");
  const net = asterChain(ctx);
  if (p.chainId !== net.chainId) no("chainId");
  if (!Array.isArray(p.params)) no("params");
  const got = new Map<string, string>();
  for (const pair of p.params) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") no("params");
    if (got.has(pair[0])) no(pair[0]);
    got.set(pair[0], String(pair[1]));
  }
  const val = (k: string) => got.get(k);
  const symbol = intent.marketId.startsWith("aster:-:") ? intent.marketId.slice("aster:-:".length) : no("market");
  if (val("symbol") !== symbol) no("market");
  if (val("type") !== "LIMIT") no("type");
  if (val("side") !== (intent.side === "buy" ? "BUY" : "SELL")) no("side");
  const tif = intent.type === "market" ? "IOC" : ASTER_TIF[intent.tif];
  if (val("timeInForce") !== tif) no("tif");
  const qty = val("quantity") ?? "";
  if (!eqDec(qty, intent.size)) no("size");
  const price = val("price") ?? "";
  if (intent.type === "limit" && !eqDec(price, intent.limitPx!)) no("price");
  priceWithin(price, intent, ctx);
  if (intent.reduceOnly ? val("reduceOnly") !== "true" : got.has("reduceOnly")) no("reduceOnly");
  const coid = val("newClientOrderId") ?? "";
  if (!ASTER_CLIENT_ID.test(coid) || (intent.clientOrderId !== undefined && coid !== intent.clientOrderId)) no("clientOrderId");
  const pin = ctx.pins.networks[ctx.network ?? "mainnet"].builders.aster;
  if (!pin || !eqAddr(val("builder"), pin)) no("builder.address");
  const fee = val("feeRate") ?? "";
  const allowed = ctx.pins.networks[ctx.network ?? "mainnet"].allowedFees.aster;
  if (!allowed.some((x) => eqDec(x, fee))) no("builder.fee");
  if (ctx.approvedMax === null || cmp(mul(fee, "10000"), String(ctx.approvedMax)) > 0) no("builder.fee");
  if (val("asterChain") !== net.name) no("network");
  const id = ctx.identity;
  if (!id?.owner || !eqAddr(val("user"), id.owner)) no("user");
  if (!id?.agentAddress || !eqAddr(val("signer"), id.agentAddress) || !eqAddr(p.signer, id.agentAddress)) no("signer");
  const nonce = Number(val("nonce"));
  if (!Number.isSafeInteger(nonce) || Math.abs(nonce / 1000 - ctx.nowMs) > 60_000) no("nonce");
  // exact order and nothing else: rebuild the signed string from the checked values
  const want: [string, string][] = [
    ["symbol", symbol],
    ["type", "LIMIT"],
    ["side", intent.side === "buy" ? "BUY" : "SELL"],
    ["timeInForce", tif],
    ["quantity", qty],
    ["price", price],
    ...(intent.reduceOnly ? ([["reduceOnly", "true"]] as [string, string][]) : []),
    ["newClientOrderId", coid],
    ["builder", val("builder")!],
    ["feeRate", fee],
    ["asterChain", net.name],
    ["user", val("user")!],
    ["signer", val("signer")!],
    ["nonce", val("nonce")!],
  ];
  let built: string;
  try {
    built = queryString(p.params);
  } catch {
    return no("params");
  }
  if (built !== want.map(([k, v]) => `${k}=${v}`).join("&")) no("params");
  const d = digestTrade(built, net.chainId);
  if (d.toLowerCase() !== b.digest.toLowerCase()) no("digest");
  return { digest: d, notional: mul(qty, price) };
}

/**
 * Check a server build against the intent. `{ ok: true, digest }` is the digest THIS code computed (the one to sign);
 * otherwise the first field that differs. Pure; reads nothing.
 */
export function checkBuild(intent: OrderIntent, b: UnsignedVenuePayload, ctx: CheckContext): CheckResult {
  try {
    validIntent(intent);
    if (intent.marketId.split(":")[0] !== ctx.venue) no("market");
    let r: { digest: Hex; notional: string };
    if (ctx.venue === "hyperliquid") r = checkHl(intent, b, ctx);
    else if (ctx.venue === "lighter-mainnet" || ctx.venue === "lighter-rh") r = checkLighter(intent, b, ctx);
    else if (ctx.venue === "aster") r = checkAster(intent, b, ctx);
    else return { ok: false, code: "PAYLOAD_MISMATCH", field: "venue" };
    runPolicy(intent, r.notional, ctx);
    return { ok: true, digest: r.digest };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, code: e.code, field: e.field };
    return { ok: false, code: "PAYLOAD_MISMATCH", field: "payload" };
  }
}

/** The same check for a cancel build: market, order id, account and digest. */
export function checkCancelBuild(c: CancelIntent, b: UnsignedVenuePayload, ctx: CheckContext): CheckResult {
  try {
    if (c.marketId.split(":")[0] !== ctx.venue) no("market");
    if (ctx.venue === "hyperliquid") {
      common(null, b, ctx, "hl_l1_action");
      const m = ctx.market as Extract<VenueMarketSpec, { venue: "hyperliquid" }> | undefined;
      if (!m || m.venue !== "hyperliquid" || m.marketId !== c.marketId) no("market");
      const p = hlCommon(b, ctx);
      const a = p.action as { type: string; cancels?: { a?: number; o?: number; asset?: number; cloid?: string }[] };
      if (!Array.isArray(a.cancels) || a.cancels.length !== 1) no("cancels");
      const x = a.cancels![0]!;
      if (c.venueOrderId !== undefined) {
        if (a.type !== "cancel" || !sameKeys(a, ["type", "cancels"]) || !sameKeys(x, ["a", "o"])) no("type");
        if (x.a !== m!.assetId) no("market");
        if (String(x.o) !== c.venueOrderId) no("venueOrderId");
      } else if (c.clientOrderId !== undefined) {
        if (a.type !== "cancelByCloid" || !sameKeys(a, ["type", "cancels"]) || !sameKeys(x, ["asset", "cloid"])) no("type");
        if (x.asset !== m!.assetId) no("market");
        if (String(x.cloid).toLowerCase() !== c.clientOrderId.toLowerCase()) no("clientOrderId");
      } else no("venueOrderId");
      return { ok: true, digest: hlDigest(p, b, ctx) };
    }
    if (ctx.venue === "lighter-mainnet" || ctx.venue === "lighter-rh") {
      common(null, b, ctx, "lighter_tx");
      const m = ctx.market as Extract<VenueMarketSpec, { venue: "lighter-mainnet" | "lighter-rh" }> | undefined;
      if (!m || (m.venue as string) !== ctx.venue || m.marketId !== c.marketId) no("market");
      const p = b.payload as { txType: number; args: Record<string, number> };
      if (!p || p.txType !== 15) no("txType");
      if (!sameKeys(p.args, ["marketIndex", "orderIndex", "nonce", "apiKeyIndex", "accountIndex", "expiredAt"])) no("args.keys");
      if (p.args.marketIndex !== m!.marketIndex) no("market");
      const id = c.venueOrderId ?? c.clientOrderId;
      if (String(p.args.orderIndex) !== id) no("venueOrderId");
      lighterAccount(p.args as { accountIndex: number; apiKeyIndex: number }, ctx);
      lighterExpiry(p.args.expiredAt!, ctx);
      return { ok: true, digest: b.digest };
    }
    if (ctx.venue === "aster") {
      common(null, b, ctx, "aster_v3_params");
      const p = b.payload as { method: string; path: string; chainId: number; params: Param[]; signer: Hex; kind: string };
      if (p.method !== "DELETE" || p.path !== "/fapi/v3/order" || p.kind !== "cancel") no("path");
      const net = asterChain(ctx);
      if (p.chainId !== net.chainId) no("chainId");
      const symbol = c.marketId.slice("aster:-:".length);
      const idPair: [string, string] = c.venueOrderId !== undefined ? ["orderId", c.venueOrderId] : c.clientOrderId !== undefined ? ["origClientOrderId", c.clientOrderId] : no("venueOrderId");
      const id = ctx.identity;
      if (!id?.owner || !id.agentAddress) no("signer");
      const nonce = p.params.find(([k]) => k === "nonce")?.[1];
      if (!Number.isSafeInteger(Number(nonce)) || Math.abs(Number(nonce) / 1000 - ctx.nowMs) > 60_000) no("nonce");
      const want = [["symbol", symbol], idPair, ["asterChain", net.name], ["user", String(p.params.find(([k]) => k === "user")?.[1])], ["signer", String(p.params.find(([k]) => k === "signer")?.[1])], ["nonce", String(nonce)]];
      if (!eqAddr(want[3]![1], id!.owner) ) no("user");
      if (!eqAddr(want[4]![1], id!.agentAddress) || !eqAddr(p.signer, id!.agentAddress)) no("signer");
      const built = queryString(p.params);
      if (built !== want.map(([k, v]) => `${k}=${v}`).join("&")) no("params");
      const d = digestTrade(built, net.chainId);
      if (d.toLowerCase() !== b.digest.toLowerCase()) no("digest");
      return { ok: true, digest: d };
    }
    return { ok: false, code: "PAYLOAD_MISMATCH", field: "venue" };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, code: e.code, field: e.field };
    return { ok: false, code: "PAYLOAD_MISMATCH", field: "payload" };
  }
}

export { ADDR as ADDRESS_RE };
