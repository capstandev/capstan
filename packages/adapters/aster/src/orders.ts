// Aster order builds (spec 4.4 step 5, 7.3, 7.4; venue-aster.md sections 4.1 and 5). The agent key signs the exact
// query string (Mode B). Every order carries the brand builder and a feeRate string (0.0002, or 0.0001 for the lock
// tier) that must not exceed the owner's approved maxFeeRate. Market orders are never sent as raw MARKET: they become
// IOC LIMIT orders at the slippage bound, and the preview is the book walk at that same limit price (quote ==
// execution).
import { ulid } from "@capstan/core";
import {
  CapstanError,
  Dec,
  type AccountSnapshot,
  type BuildContext,
  type CancelIntent,
  type Hex,
  type Market,
  type OrderBook,
  type OrderIntent,
  type OrderPreview,
  type SubmitResult,
  type UnsignedReceipt,
  type UnsignedVenuePayload,
  type VenueIdentity,
} from "@capstan/schema";
import { AsterNonce, decimalString, digestTrade, queryString, type Param } from "@capstan/signer-aster";
import { ASTER_FEES, type AsterNetwork } from "./config";
import { symbolOf } from "./normalize";

const S = 18;
const d = (x: string) => Dec.parse(x, S, "half_even");
const str = (x: Dec) => Dec.toString(x);
export const BUILD_TTL_MS = 30_000;
/** Aster base taker fee in bps (VERIFY: venue fee page; owner tier unknown without a signed read). */
export const ASTER_BASE_TAKER_BPS = 3.5;
/** Default slippage bound for close-all orders built from the mark. */
export const CLOSE_ALL_SLIPPAGE_BPS = 300;
/** An ingested snapshot older than this cannot drive a close-all. */
export const SNAPSHOT_MAX_AGE_MS = 60_000;

export type AsterTif = "GTC" | "IOC" | "GTX";
const TIF: Record<OrderIntent["tif"], AsterTif> = { gtc: "GTC", ioc: "IOC", alo: "GTX" };
const CLIENT_ID_RE = /^[A-Za-z0-9_.:/-]{1,36}$/;

/** What the delegated key signs, plus what the relay needs to send it. */
export interface AsterOrderPayload {
  method: "POST" | "DELETE";
  path: "/fapi/v3/order";
  chainId: 1666 | 714;
  params: Param[];
  signer: Hex;
  clientOrderId: string | null;
  kind: "order" | "cancel";
}

export interface AsterBuildDeps {
  network: AsterNetwork;
  builder: Hex;
  market: (marketId: string) => Promise<Market>;
  book: (marketId: string) => Promise<OrderBook>;
  nonceFor: (signer: Hex) => AsterNonce;
  venueFeeBps?: number;
}

export class AsterNeedsSignedRead extends CapstanError {
  readonly reason = "needs_signed_read" as const;
  constructor(message = "needs_signed_read: post a fresh signed account read to /v1/risk/ingest first") {
    super("INVALID_INPUT", message, { field: "needs_signed_read" });
    this.name = "AsterNeedsSignedRead";
  }
}

// ---------------------------------------------------------------- fees
/** 2 bps by default, 1 bp for the lock tier; never above the owner's approved maxFeeRate. */
export function feeRateFor(ctx: Pick<BuildContext, "builderFee" | "approvedMaxBps">): "0.0002" | "0.0001" {
  const rate: "0.0002" | "0.0001" = ctx.builderFee?.decimalRate === ASTER_FEES.lockFeeRate ? "0.0001" : "0.0002";
  if (ctx.builderFee?.decimalRate !== undefined && ctx.builderFee.decimalRate !== ASTER_FEES.lockFeeRate && ctx.builderFee.decimalRate !== ASTER_FEES.feeRate) {
    throw new CapstanError("INVALID_INPUT", "Aster fee rate must be 0.0002 or 0.0001", { field: "builderFee" });
  }
  const approvedBps = ctx.approvedMaxBps;
  if (approvedBps === null || approvedBps === undefined || !Number.isFinite(approvedBps)) throw new CapstanError("BUILDER_APPROVAL_REQUIRED");
  const approved = Dec.div(Dec.parse(String(approvedBps), 6, "down"), Dec.parse("10000", 0), S, "down");
  if (Dec.cmp(d(rate), approved) > 0) throw new CapstanError("BUILDER_APPROVAL_REQUIRED", `feeRate ${rate} is above the approved maximum`);
  return rate;
}

export function feeBpsOf(rate: string): number {
  return Number(str(Dec.mul(d(rate), Dec.parse("10000", 0), 6)));
}

// ---------------------------------------------------------------- book walk
export interface Walk {
  filled: string;
  avgPx: string | null;
  notional: string;
  worstPx: string | null;
  complete: boolean;
}

/** Walk the book for `size`, taking only levels at or better than `limitPx` when given. */
export function walkBook(book: OrderBook, side: "buy" | "sell", size: string, limitPx?: string): Walk {
  const levels = side === "buy" ? book.asks : book.bids;
  const lim = limitPx === undefined ? null : d(limitPx);
  let left = d(size);
  let filled = d("0");
  let notional = d("0");
  let worst: Dec | null = null;
  for (const [pxS, szS] of levels) {
    if (Dec.cmp(left, d("0")) <= 0) break;
    const px = d(pxS);
    if (lim && (side === "buy" ? Dec.cmp(px, lim) > 0 : Dec.cmp(px, lim) < 0)) break;
    const take = Dec.min(left, d(szS));
    filled = Dec.add(filled, take);
    notional = Dec.add(notional, Dec.mul(take, px, S));
    left = Dec.sub(left, take);
    worst = px;
  }
  return {
    filled: str(filled),
    avgPx: Dec.isZero(filled) ? null : str(Dec.div(notional, filled, S)),
    notional: str(notional),
    worstPx: worst ? str(worst) : null,
    complete: Dec.cmp(left, d("0")) <= 0,
  };
}

/** Best price on the side we take, moved by `bps` against us and rounded to the tick toward the stricter side. */
export function slippageBound(book: OrderBook, side: "buy" | "sell", bps: number, tickSize: string): string {
  const best = (side === "buy" ? book.asks : book.bids)[0]?.[0];
  if (!best) throw new CapstanError("STALE_QUOTE", "the book has no levels on that side");
  return boundFrom(best, side, bps, tickSize);
}

export function boundFrom(ref: string, side: "buy" | "sell", bps: number, tickSize: string): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw new CapstanError("INVALID_INPUT", "maxSlippageBps must be an integer 0..5000", { field: "maxSlippageBps" });
  const f = Dec.div(Dec.parse(String(bps), 0), Dec.parse("10000", 0), S);
  const one = d("1");
  const raw = Dec.mul(d(ref), side === "buy" ? Dec.add(one, f) : Dec.sub(one, f), S);
  const px = Dec.roundToStep(raw, d(tickSize), side === "buy" ? "down" : "up");
  if (Dec.cmp(px, d("0")) <= 0) throw new CapstanError("INVALID_INPUT", "slippage bound is not a positive price");
  return str(px);
}

function assertStep(x: string, step: string, field: string): string {
  const v = d(decimalStringOr(x, field));
  if (Dec.cmp(v, d("0")) <= 0) throw new CapstanError("INVALID_INPUT", `${field} must be above zero`, { field });
  if (!Dec.eq(Dec.roundToStep(v, d(step), "down"), v)) throw new CapstanError("INVALID_INPUT", `${field} must be a multiple of ${step}`, { field });
  return str(v);
}

function decimalStringOr(x: string, field: string): string {
  try {
    return decimalString(x);
  } catch {
    throw new CapstanError("INVALID_INPUT", `${field} must be a plain decimal string`, { field });
  }
}

function nonceNumber(n: AsterNonce, nowMs: number): number {
  return Number(n.next(BigInt(nowMs) * 1000n));
}

function signerOf(ctx: BuildContext): Hex {
  const a = ctx.identity.agentAddress;
  if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new CapstanError("INVALID_INPUT", "the build needs the agent (signer) address", { field: "agentAddress" });
  return a;
}

export interface BuildOptions {
  /** A reduce-only close on a liquidation path: Aster pays no builder fee there, so the preview promises none. */
  liquidationPath?: boolean;
}

// ---------------------------------------------------------------- build order
export async function buildAsterOrder(intent: OrderIntent, ctx: BuildContext, deps: AsterBuildDeps, opts: BuildOptions = {}): Promise<UnsignedVenuePayload> {
  const symbol = symbolOf(intent.marketId);
  const market = await deps.market(intent.marketId);
  if (market.status !== "active" && !(market.status === "reduce_only" && intent.reduceOnly)) throw new CapstanError("MARKET_NOT_EXECUTABLE");
  if (intent.side !== "buy" && intent.side !== "sell") throw new CapstanError("INVALID_INPUT", "side", { field: "side" });
  const feeRate = feeRateFor(ctx); // refuses before anything is built when above the approval
  const signer = signerOf(ctx);
  const quantity = assertStep(intent.size, market.lotSize, "size");
  const book = await deps.book(intent.marketId);
  let price: string;
  let tif: AsterTif;
  if (intent.type === "market") {
    // never a raw MARKET: IOC LIMIT at the slippage bound
    price = slippageBound(book, intent.side, intent.maxSlippageBps, market.tickSize);
    tif = "IOC";
  } else {
    if (!intent.limitPx) throw new CapstanError("INVALID_INPUT", "a limit order needs limitPx", { field: "limitPx" });
    price = assertStep(intent.limitPx, market.tickSize, "limitPx");
    tif = TIF[intent.tif];
    if (!tif) throw new CapstanError("INVALID_INPUT", "tif", { field: "tif" });
  }
  const clientOrderId = intent.clientOrderId ?? `cp${ulid(ctx.nowMs).toLowerCase()}`;
  if (!CLIENT_ID_RE.test(clientOrderId)) throw new CapstanError("INVALID_INPUT", "clientOrderId must be 1 to 36 of A-Z a-z 0-9 _ . : / -", { field: "clientOrderId" });
  const params: Param[] = [
    ["symbol", symbol],
    ["type", "LIMIT"],
    ["side", intent.side === "buy" ? "BUY" : "SELL"],
    ["timeInForce", tif],
    ["quantity", quantity],
    ["price", price],
  ];
  if (intent.reduceOnly) params.push(["reduceOnly", "true"]);
  params.push(["newClientOrderId", clientOrderId], ["builder", deps.builder], ["feeRate", feeRate], ["asterChain", deps.network], ["user", ctx.owner], ["signer", signer], ["nonce", nonceNumber(deps.nonceFor(signer), ctx.nowMs)]);
  const chainId = deps.network === "Testnet" ? 714 : 1666;
  const payload: AsterOrderPayload = { method: "POST", path: "/fapi/v3/order", chainId, params, signer, clientOrderId, kind: "order" };
  const preview = previewFor(intent, market, book, price, quantity, feeRate, deps, opts);
  if (market.minNotional && Dec.cmp(d(preview.notionalUsd), d(market.minNotional)) < 0) throw new CapstanError("INVALID_INPUT", `order notional is under the venue minimum ${market.minNotional}`, { field: "size" });
  return {
    buildId: ulid(ctx.nowMs),
    venue: "aster",
    signer: "delegated_key",
    encoding: "aster_v3_params",
    payload,
    digest: digestTrade(queryString(params), chainId),
    preview,
    expiresAt: ctx.nowMs + BUILD_TTL_MS,
    eligibilityDecisionId: ctx.eligibilityDecisionId,
  };
}

function previewFor(intent: OrderIntent, market: Market, book: OrderBook, price: string, quantity: string, feeRate: string, deps: AsterBuildDeps, opts: BuildOptions): OrderPreview {
  const w = walkBook(book, intent.side, quantity, price);
  const best = (intent.side === "buy" ? book.asks : book.bids)[0]?.[0] ?? null;
  const warnings: string[] = [];
  if (!w.complete) warnings.push(`only ${w.filled} of ${quantity} is available at or better than ${price}`);
  if (market.status === "reduce_only") warnings.push("market is settling: reduce-only");
  const noFee = opts.liquidationPath === true;
  if (noFee) warnings.push("liquidation path: no builder fee is charged");
  const avg = w.avgPx ?? price;
  const slip = best && w.avgPx ? Math.abs(Number(str(Dec.div(Dec.mul(Dec.sub(d(w.avgPx), d(best)), d("10000"), S), d(best), 6)))) : 0;
  const fee = feeBpsOf(feeRate);
  return {
    marketId: intent.marketId,
    side: intent.side,
    size: quantity,
    px: price,
    notionalUsd: str(Dec.mul(d(quantity), d(avg), S)),
    venueFeeBps: deps.venueFeeBps ?? ASTER_BASE_TAKER_BPS,
    builderFeeBps: noFee ? 0 : fee,
    builderFee: noFee ? null : { address: deps.builder, rawUnit: `feeRate=${feeRate}` },
    slippageBps: Math.round(slip * 100) / 100,
    estLiqPx: null,
    collateralAsset: market.collateralAsset,
    reduceOnly: intent.reduceOnly,
    warnings,
  };
}

/** Re-issue a build with a fresh nonce (SDK path after -4225). The relay never calls this: it holds no key. */
export function withFreshNonce(build: UnsignedVenuePayload, nonce: AsterNonce, nowMs: number): UnsignedVenuePayload {
  const p = build.payload as AsterOrderPayload;
  const params = p.params.map(([k, v]) => (k === "nonce" ? ([k, nonceNumber(nonce, nowMs)] as Param) : ([k, v] as Param)));
  return { ...build, buildId: ulid(nowMs), payload: { ...p, params }, digest: digestTrade(queryString(params), p.chainId), expiresAt: nowMs + BUILD_TTL_MS };
}

// ---------------------------------------------------------------- cancel
export async function buildAsterCancel(req: CancelIntent, ctx: BuildContext, deps: AsterBuildDeps): Promise<UnsignedVenuePayload> {
  const symbol = symbolOf(req.marketId);
  const signer = signerOf(ctx);
  const params: Param[] = [["symbol", symbol]];
  if (req.venueOrderId) {
    if (!/^\d{1,20}$/.test(req.venueOrderId)) throw new CapstanError("INVALID_INPUT", "venueOrderId", { field: "venueOrderId" });
    params.push(["orderId", req.venueOrderId]);
  } else if (req.clientOrderId) {
    if (!CLIENT_ID_RE.test(req.clientOrderId)) throw new CapstanError("INVALID_INPUT", "clientOrderId", { field: "clientOrderId" });
    params.push(["origClientOrderId", req.clientOrderId]);
  } else throw new CapstanError("INVALID_INPUT", "give venueOrderId or clientOrderId", { field: "venueOrderId" });
  params.push(["asterChain", deps.network], ["user", ctx.owner], ["signer", signer], ["nonce", nonceNumber(deps.nonceFor(signer), ctx.nowMs)]);
  const chainId = deps.network === "Testnet" ? 714 : 1666;
  const market = await deps.market(req.marketId);
  return {
    buildId: ulid(ctx.nowMs),
    venue: "aster",
    signer: "delegated_key",
    encoding: "aster_v3_params",
    payload: { method: "DELETE", path: "/fapi/v3/order", chainId, params, signer, clientOrderId: req.clientOrderId ?? null, kind: "cancel" } satisfies AsterOrderPayload,
    digest: digestTrade(queryString(params), chainId),
    preview: { marketId: req.marketId, side: "buy", size: "0", px: null, notionalUsd: "0", venueFeeBps: 0, builderFeeBps: 0, builderFee: null, slippageBps: 0, estLiqPx: null, collateralAsset: market.collateralAsset, reduceOnly: true, warnings: ["cancel"] },
    expiresAt: ctx.nowMs + BUILD_TTL_MS,
    eligibilityDecisionId: ctx.eligibilityDecisionId,
  };
}

// ---------------------------------------------------------------- close-all (spec 7.4)
/** One reduce-only IOC LIMIT per position from the latest ingested snapshot (under 60 s old). */
export async function buildAsterCloseAll(
  id: VenueIdentity,
  ctx: BuildContext & { snapshot: AccountSnapshot | null },
  deps: AsterBuildDeps,
  opts: { slippageBps?: number; liquidationPath?: boolean } = {},
): Promise<UnsignedVenuePayload[]> {
  const snap = ctx.snapshot;
  if (!snap || snap.venue !== "aster" || snap.identity.owner.toLowerCase() !== id.owner.toLowerCase()) throw new AsterNeedsSignedRead();
  if (ctx.nowMs - Date.parse(snap.asOf) > SNAPSHOT_MAX_AGE_MS) throw new AsterNeedsSignedRead();
  const out: UnsignedVenuePayload[] = [];
  for (const p of snap.positions) {
    if (Dec.isZero(d(p.size))) continue;
    const market = await deps.market(p.marketId);
    const side = p.side === "long" ? "sell" : "buy";
    const limitPx = boundFrom(p.markPx, side, opts.slippageBps ?? CLOSE_ALL_SLIPPAGE_BPS, market.tickSize);
    const intent: OrderIntent = { marketId: p.marketId, side, size: p.size, type: "limit", limitPx, tif: "ioc", reduceOnly: true, maxSlippageBps: opts.slippageBps ?? CLOSE_ALL_SLIPPAGE_BPS };
    out.push(await buildAsterOrder(intent, ctx, { ...deps, market: async () => ({ ...market, minNotional: null }) }, { liquidationPath: opts.liquidationPath === true }));
  }
  return out;
}

// ---------------------------------------------------------------- receipts and reconciliation hints
export type AsterReceiptDraft = Pick<UnsignedReceipt, "venue" | "marketId" | "buildId" | "builder" | "venueOrderId" | "txHash" | "eligibilityDecisionId"> & {
  action: "order.submit" | "order.cancel";
  status: SubmitResult["status"];
  venueResponse: unknown;
};

export function toReceiptDraft(build: UnsignedVenuePayload, result: SubmitResult): AsterReceiptDraft {
  const p = build.payload as AsterOrderPayload;
  const feeRate = p.params.find(([k]) => k === "feeRate")?.[1] as string | undefined;
  const builder = p.params.find(([k]) => k === "builder")?.[1] as Hex | undefined;
  return {
    action: p.kind === "cancel" ? "order.cancel" : "order.submit",
    venue: "aster",
    marketId: build.preview.marketId,
    buildId: build.buildId,
    builder: feeRate && builder ? { address: builder, feeBps: feeBpsOf(feeRate), rawUnit: `feeRate=${feeRate}` } : null,
    venueOrderId: result.venueOrderId,
    txHash: null,
    eligibilityDecisionId: build.eligibilityDecisionId,
    status: result.status,
    venueResponse: result.venueResponse,
  };
}

/**
 * Reconciler hint (todo 27): liquidation and ADL fills earn no builder fee. Aster follows the Binance convention of
 * venue-made client ids (VERIFY on testnet): `autoclose-*` for liquidations, `adl_autoclose*` for ADL.
 */
export function fillFeeHint(trade: { clientOrderId?: string | null; orderType?: string | null; liquidation?: boolean | null }): { isLiquidation: boolean; expectBuilderFee: boolean } {
  const cid = (trade.clientOrderId ?? "").toLowerCase();
  const isLiquidation = trade.liquidation === true || cid.startsWith("autoclose-") || cid.startsWith("adl_autoclose") || (trade.orderType ?? "").toUpperCase() === "LIQUIDATION";
  return { isLiquidation, expectBuilderFee: !isLiquidation };
}

