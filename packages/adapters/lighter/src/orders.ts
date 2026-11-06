// Order, cancel and close-all builds. The server never signs: it returns the exact signer arguments, the
// pre-signature tx hash from a hash-only WASM instance (the hash depends on the fields and the signing id, not on the
// key), and a preview whose average fill is the walk of the cached book up to the built integer price, so the quote
// and the execution bound are the same number.
// Fees: venue fee from the owner's tier (Standard when unknown); integrator fee 0 and builder fee 0 on every build
// (zero-fee attribution, DECISIONS #15, BACKLOG C11).
import { ulid } from "@capstan/core";
import { CapstanError, Dec, type BuildContext, type CancelIntent, type Hex, type OrderBook, type OrderIntent, type OrderPreview, type UnsignedVenuePayload, type VenueIdentity } from "@capstan/schema";
import type { LighterCancelArgs, LighterHasher, LighterOrderArgs } from "@capstan/signer-lighter-wasm";
import type { LighterConfig } from "./config";
import { latencyWarnings, type LighterFeeRow, type LighterTier } from "./fees";
import { isUsableKeyIndex } from "./keyindex";
import { fromVenueUnits, priceToUnits, sizeToUnits } from "./normalize";
import type { NonceTracker } from "./nonce";
import type { LighterMarketMeta, LighterReader } from "./read";

export const BUILD_VALID_MS = 30_000;
/** lighter-go DefaultExpireTime: a tx expires 10 min - 1 s after it is built. */
export const TX_EXPIRY_MS = 10 * 60_000 - 1000;
/** The API refuses a tx whose ExpiredAt is less than about 5 s away. */
export const MIN_TX_EXPIRY_LEAD_MS = 5000;
export const GTT_MIN_MS = 5 * 60_000;
export const GTT_MAX_MS = 30 * 24 * 3600_000;
export const GTT_DEFAULT_MS = 28 * 24 * 3600_000;
export const CLOSE_ALL_DEFAULT_SLIPPAGE_BPS = 100;

export const LIGHTER_ORDER_TYPE = { limit: 0, market: 1 } as const;
export const LIGHTER_TIF = { ioc: 0, gtt: 1, postOnly: 2 } as const;
export const TX_TYPE = { changePubKey: 8, createOrder: 14, cancelOrder: 15, cancelAll: 16, approveIntegrator: 45 } as const;

export type LighterTxPayload = { txType: 14; args: LighterOrderArgs & { expiredAt: number } } | { txType: 15; args: LighterCancelArgs & { expiredAt: number } };

export type HashOnly = Pick<LighterHasher, "txHashForOrder" | "txHashForCancel">;

export interface LighterBuild extends UnsignedVenuePayload {
  encoding: "lighter_tx";
  payload: LighterTxPayload;
  /** The book walk behind the preview: the average fill and how much fills at the built price. */
  quote: { avgFillPx: string | null; filledSize: string; worstPx: string | null; bookAsOf: string | null } | null;
}

export interface OrderBuildContext extends BuildContext {
  cfg: Readonly<LighterConfig>;
  market: LighterMarketMeta;
  nonce: number;
  clientOrderIndex: number;
  integratorAccountIndex: number;
  hasher: HashOnly;
  fee: LighterFeeRow & { tier: LighterTier };
  book?: OrderBook | null;
  expiredAt?: number;
  orderExpiryMs?: number;
}

export interface Walk {
  filled: ReturnType<typeof Dec.parse>;
  avg: ReturnType<typeof Dec.parse> | null;
  worst: string | null;
}

const S = 12;
const D = (s: string) => Dec.parse(s, S, "half_even");

/** Walk the book side a taker hits (asks for a buy, bids for a sell), never past the limit price. */
export function walkBook(book: OrderBook, side: "buy" | "sell", size: string, limitPx: string | null): Walk {
  const levels = side === "buy" ? book.asks : book.bids;
  let left = D(size);
  let filled = Dec.parse("0", S);
  let cost = Dec.parse("0", S);
  let worst: string | null = null;
  const limit = limitPx === null ? null : D(limitPx);
  for (const [px, sz] of levels) {
    if (Dec.isZero(left) || Dec.cmp(left, Dec.parse("0", S)) < 0) break;
    const p = D(px);
    if (limit && (side === "buy" ? Dec.cmp(p, limit) > 0 : Dec.cmp(p, limit) < 0)) break;
    const take = Dec.min(left, D(sz));
    filled = Dec.add(filled, take);
    cost = Dec.add(cost, Dec.mul(take, p, S, "half_even"));
    left = Dec.sub(left, take);
    worst = px;
  }
  return { filled, avg: Dec.isZero(filled) ? null : Dec.div(cost, filled, 8, "half_even"), worst };
}

function venueChecks(cfg: Readonly<LighterConfig>, id: VenueIdentity, m: LighterMarketMeta, reduceOnly: boolean): { accountIndex: number; apiKeyIndex: number } {
  if (id.venue !== cfg.venue || m.market.venue !== cfg.venue) throw new CapstanError("INVALID_INPUT", `identity, market and config must all be ${cfg.venue}`);
  if (id.accountIndex === undefined || id.apiKeyIndex === undefined) throw new CapstanError("INVALID_INPUT", "a Lighter identity needs accountIndex and apiKeyIndex");
  if (!isUsableKeyIndex(id.apiKeyIndex)) throw new CapstanError("INVALID_INPUT", `API key index ${id.apiKeyIndex} is reserved or out of range`);
  if (m.market.marketType !== "perp") throw new CapstanError("MARKET_NOT_EXECUTABLE", `${m.market.id} is ${m.market.marketType}, only perps execute`);
  if (!m.market.executable) throw new CapstanError("MARKET_NOT_EXECUTABLE");
  if (m.market.status === "reduce_only" && !reduceOnly) throw new CapstanError("MARKET_NOT_EXECUTABLE", `${m.market.id} is reduce only`);
  if (m.market.status !== "active" && m.market.status !== "reduce_only") throw new CapstanError("MARKET_NOT_EXECUTABLE", `${m.market.id} is ${m.market.status}`);
  return { accountIndex: id.accountIndex, apiKeyIndex: id.apiKeyIndex };
}

function txExpiry(nowMs: number, expiredAt?: number): number {
  const e = expiredAt ?? nowMs + TX_EXPIRY_MS;
  if (!Number.isSafeInteger(e) || e - nowMs < MIN_TX_EXPIRY_LEAD_MS) throw new CapstanError("INVALID_INPUT", "tx expiry must be at least 5 s away");
  if (e - nowMs > TX_EXPIRY_MS) throw new CapstanError("INVALID_INPUT", "tx expiry must be within 10 minutes");
  return e;
}

function orderExpiry(tif: OrderIntent["tif"], nowMs: number, override?: number): number {
  if (tif === "ioc") {
    if (override !== undefined && override !== 0) throw new CapstanError("INVALID_INPUT", "IOC orders use order expiry 0");
    return 0;
  }
  const e = override ?? nowMs + GTT_DEFAULT_MS;
  if (!Number.isSafeInteger(e) || e - nowMs < GTT_MIN_MS || e - nowMs > GTT_MAX_MS) throw new CapstanError("INVALID_INPUT", "GTT order expiry must be 5 minutes to 30 days away");
  return e;
}

const bpsBetween = (a: ReturnType<typeof Dec.parse>, ref: ReturnType<typeof Dec.parse>) => {
  if (Dec.isZero(ref)) return 0;
  return Math.abs(Number(Dec.toString(Dec.div(Dec.mul(Dec.sub(a, ref), Dec.parse("10000", 0), S), ref, 4, "half_even"))));
};

/** Build a create-order tx for the delegated key to sign. */
export async function buildOrder(intent: OrderIntent, ctx: OrderBuildContext): Promise<LighterBuild> {
  const { cfg, market: m, nowMs } = ctx;
  if (intent.marketId !== m.market.id) throw new CapstanError("INVALID_INPUT", "intent and market differ");
  const { accountIndex, apiKeyIndex } = venueChecks(cfg, ctx.identity, m, intent.reduceOnly);
  if (intent.leverage !== undefined && m.market.maxLeverage !== null && intent.leverage > m.market.maxLeverage) throw new CapstanError("INVALID_INPUT", `leverage ${intent.leverage} is above the market maximum ${m.market.maxLeverage}`);
  if (!Number.isInteger(intent.maxSlippageBps) || intent.maxSlippageBps < 0 || intent.maxSlippageBps > 5000) throw new CapstanError("INVALID_INPUT", "maxSlippageBps must be 0..5000");
  if (intent.type === "market" && intent.tif !== "ioc") throw new CapstanError("INVALID_INPUT", "market orders are IOC");

  const baseAmount = sizeToUnits(intent.size, m.sizeDecimals); // never rounds up
  const minUnits = m.minBaseAmount ? sizeToUnits(m.minBaseAmount, m.sizeDecimals) : 1;
  // a reduce-only close may be below the opening minimum (dust left by a partial fill must still be closable)
  if (baseAmount < 1 || (!intent.reduceOnly && baseAmount < minUnits)) throw new CapstanError("INVALID_INPUT", `size is below the market minimum ${m.minBaseAmount ?? fromVenueUnits(1, m.sizeDecimals)}`);
  const size = fromVenueUnits(baseAmount, m.sizeDecimals);

  const book = ctx.book ?? null;
  const best = book ? (intent.side === "buy" ? book.asks[0]?.[0] : book.bids[0]?.[0]) : undefined;
  let priceUnits: number;
  if (intent.type === "limit") {
    if (!intent.limitPx) throw new CapstanError("INVALID_INPUT", "a limit order needs limitPx");
    // a buy never pays above its limit, a sell never sells below it
    priceUnits = priceToUnits(intent.limitPx, m.priceDecimals, intent.side === "buy" ? "down" : "up");
  } else {
    const ref = best ?? m.markPx;
    if (!ref) throw new CapstanError("STALE_QUOTE", `no book or mark for ${m.market.id}`);
    const f = Dec.parse(String(intent.maxSlippageBps), 0);
    const one = Dec.parse("10000", 0);
    const bound = Dec.div(Dec.mul(D(ref), intent.side === "buy" ? Dec.add(one, f) : Dec.sub(one, f), S), one, S, "half_even");
    // the protective price never lies beyond the slippage bound
    priceUnits = priceToUnits(Dec.toString(bound), m.priceDecimals, intent.side === "buy" ? "down" : "up");
  }
  if (priceUnits < 1) throw new CapstanError("INVALID_INPUT", "price rounds to zero");
  const px = fromVenueUnits(priceUnits, m.priceDecimals);

  const tif = intent.tif === "ioc" ? LIGHTER_TIF.ioc : intent.tif === "alo" ? LIGHTER_TIF.postOnly : LIGHTER_TIF.gtt;
  const expiredAt = txExpiry(nowMs, ctx.expiredAt);
  const args: LighterOrderArgs & { expiredAt: number } = {
    marketIndex: m.marketIndex,
    clientOrderIndex: ctx.clientOrderIndex,
    baseAmount,
    price: priceUnits,
    isAsk: intent.side === "sell",
    orderType: intent.type === "market" ? LIGHTER_ORDER_TYPE.market : LIGHTER_ORDER_TYPE.limit,
    timeInForce: tif,
    reduceOnly: intent.reduceOnly,
    triggerPrice: 0,
    orderExpiry: orderExpiry(intent.tif, nowMs, ctx.orderExpiryMs),
    integratorAccountIndex: ctx.integratorAccountIndex,
    integratorTakerFee: 0,
    integratorMakerFee: 0,
    selfTradeBehaviorMode: 0,
    selfTradeEqualityMode: 0,
    nonce: ctx.nonce,
    apiKeyIndex,
    accountIndex,
    expiredAt,
  };
  if (!Number.isSafeInteger(args.clientOrderIndex) || args.clientOrderIndex < 1 || args.clientOrderIndex > 2 ** 48 - 1) throw new CapstanError("INVALID_INPUT", "clientOrderIndex must be 1 .. 2^48 - 1");
  const digest = `0x${await ctx.hasher.txHashForOrder(args)}` as Hex;

  // quote == execution: walk the cached book up to the built integer price
  const walk = book ? walkBook(book, intent.side, size, px) : null;
  const avg = walk?.avg ?? null;
  const refPx = best ? D(best) : m.markPx ? D(m.markPx) : null;
  const notional = Dec.mul(D(size), avg ?? D(px), 2, "half_even");
  const maker = intent.tif === "alo";
  const warnings = [...latencyWarnings(cfg.venue, ctx.fee.tier, intent.tif)];
  if (baseAmount < minUnits) warnings.push(`size is below the market minimum ${m.minBaseAmount}; the venue may refuse it`);
  if (walk && Dec.cmp(walk.filled, D(size)) < 0) warnings.push(`the book fills ${Dec.toString(walk.filled)} of ${size} at or inside ${px}`);
  const preview: OrderPreview = {
    marketId: m.market.id,
    side: intent.side,
    size,
    px,
    notionalUsd: Dec.toString(notional),
    venueFeeBps: maker ? ctx.fee.makerBps : ctx.fee.takerBps,
    builderFeeBps: 0,
    builderFee: null,
    slippageBps: avg && refPx ? bpsBetween(avg, refPx) : 0,
    estLiqPx: null,
    collateralAsset: cfg.collateral,
    reduceOnly: intent.reduceOnly,
    warnings,
  };
  return {
    buildId: ulid(nowMs),
    venue: cfg.venue,
    signer: "delegated_key",
    encoding: "lighter_tx",
    payload: { txType: TX_TYPE.createOrder, args },
    digest,
    preview,
    expiresAt: nowMs + BUILD_VALID_MS,
    eligibilityDecisionId: ctx.eligibilityDecisionId,
    quote: walk ? { avgFillPx: avg ? Dec.toString(avg) : null, filledSize: Dec.toString(walk.filled), worstPx: walk.worst, bookAsOf: book?.asOf ?? null } : null,
  };
}

export interface CancelBuildContext extends BuildContext {
  cfg: Readonly<LighterConfig>;
  market: LighterMarketMeta;
  nonce: number;
  hasher: HashOnly;
  expiredAt?: number;
}

/** Build a cancel (tx type 15) by venue order index or client order index. */
export async function buildCancel(req: CancelIntent, ctx: CancelBuildContext): Promise<LighterBuild> {
  const { cfg, market: m, nowMs } = ctx;
  if (req.marketId !== m.market.id) throw new CapstanError("INVALID_INPUT", "cancel and market differ");
  const id = ctx.identity;
  if (id.venue !== cfg.venue || m.market.venue !== cfg.venue) throw new CapstanError("INVALID_INPUT", `identity, market and config must all be ${cfg.venue}`);
  if (id.accountIndex === undefined || id.apiKeyIndex === undefined || !isUsableKeyIndex(id.apiKeyIndex)) throw new CapstanError("INVALID_INPUT", "a Lighter identity needs accountIndex and a usable apiKeyIndex");
  const raw = req.venueOrderId ?? req.clientOrderId;
  if (raw === undefined || !/^\d{1,16}$/.test(raw)) throw new CapstanError("INVALID_INPUT", "cancel needs a numeric venueOrderId or clientOrderId");
  const orderIndex = Number(raw);
  if (!Number.isSafeInteger(orderIndex) || orderIndex < 1) throw new CapstanError("INVALID_INPUT", "order index out of range");
  const args: LighterCancelArgs & { expiredAt: number } = { marketIndex: m.marketIndex, orderIndex, nonce: ctx.nonce, apiKeyIndex: id.apiKeyIndex, accountIndex: id.accountIndex, expiredAt: txExpiry(nowMs, ctx.expiredAt) };
  const digest = `0x${await ctx.hasher.txHashForCancel(args)}` as Hex;
  return {
    buildId: ulid(nowMs),
    venue: cfg.venue,
    signer: "delegated_key",
    encoding: "lighter_tx",
    payload: { txType: TX_TYPE.cancelOrder, args },
    digest,
    preview: { marketId: m.market.id, side: "buy", size: "0", px: null, notionalUsd: "0", venueFeeBps: 0, builderFeeBps: 0, builderFee: null, slippageBps: 0, estLiqPx: null, collateralAsset: cfg.collateral, reduceOnly: true, warnings: [`cancel order ${raw}`] },
    expiresAt: nowMs + BUILD_VALID_MS,
    eligibilityDecisionId: ctx.eligibilityDecisionId,
    quote: null,
  };
}

export interface CloseAllContext extends BuildContext {
  cfg: Readonly<LighterConfig>;
  reader: Pick<LighterReader, "getAccount" | "marketMeta">;
  nonces: NonceTracker;
  hasher: HashOnly;
  fee: LighterFeeRow & { tier: LighterTier };
  integratorAccountIndex: number;
  books?: Map<string, OrderBook>;
  maxSlippageBps?: number;
}

/**
 * Spec 7.4: one reduce-only IOC per open position (from the public account read), sized to the full position at the
 * slippage bound, consecutive nonces on one key. Never an opening order. Used by close-all and the kill response.
 */
export async function buildCloseAll(id: VenueIdentity, ctx: CloseAllContext): Promise<LighterBuild[]> {
  const acct = await ctx.reader.getAccount(id);
  if (id.apiKeyIndex === undefined) throw new CapstanError("INVALID_INPUT", "close-all needs the key index that signs");
  if (!ctx.nonces.seeded(id.accountIndex!, id.apiKeyIndex)) await ctx.nonces.seed(id.accountIndex!, id.apiKeyIndex);
  const out: LighterBuild[] = [];
  for (const p of acct.positions) {
    const meta = await ctx.reader.marketMeta(p.marketId);
    const intent: OrderIntent = { marketId: p.marketId, side: p.side === "long" ? "sell" : "buy", size: p.size, type: "market", tif: "ioc", reduceOnly: true, maxSlippageBps: ctx.maxSlippageBps ?? CLOSE_ALL_DEFAULT_SLIPPAGE_BPS };
    out.push(
      await buildOrder(intent, {
        ...ctx,
        identity: id,
        market: { ...meta, market: { ...meta.market, executable: true }, markPx: meta.markPx ?? p.markPx }, // closing is allowed on any perp the account holds
        nonce: ctx.nonces.next(id.accountIndex!, id.apiKeyIndex),
        clientOrderIndex: ctx.nonces.nextClientOrderIndex(id.accountIndex!, id.apiKeyIndex),
        book: ctx.books?.get(p.marketId) ?? null,
      }),
    );
  }
  return out;
}
