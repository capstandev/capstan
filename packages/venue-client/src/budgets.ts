// Published venue rate limits (live facts, 2026-11-05) and the per-call cost tables. The governor keeps every venue
// under 80% of its limit for normal traffic; safety calls (cancels, kill-switch reads, close-all) may use the rest.
export type VenueKey =
  | "hyperliquid"
  | "hyperliquid-testnet"
  | "lighter-304"
  | "lighter-466324"
  | "lighter-300"
  | "aster"
  | "aster-testnet"
  | "variational"
  | "arcus"
  | "arcus-testnet";

/** A per-L1 Lighter submit bucket: `lighter-<cfg>:l1:<address>`. */
export type LighterL1Key = `${"lighter-304" | "lighter-466324" | "lighter-300"}:l1:${string}`;
export type BucketKey = VenueKey | LighterL1Key;

export type Priority = "safety" | "pro" | "free";

export interface Budget {
  venue: BucketKey;
  egress: string;
  unit: "weight" | "request";
  perWindow: number;
  windowMs: number;
  ceiling: 0.8;
  minIntervalMs?: number; // Lighter: at most one request per second per config
}

const weight = (perWindow: number, windowMs: number) => ({ unit: "weight" as const, perWindow, windowMs, ceiling: 0.8 as const });
const request = (perWindow: number, windowMs: number, minIntervalMs?: number) => ({
  unit: "request" as const,
  perWindow,
  windowMs,
  ceiling: 0.8 as const,
  ...(minIntervalMs ? { minIntervalMs } : {}),
});

export const BUDGETS: Record<VenueKey, Omit<Budget, "egress" | "venue">> = {
  // 1,200 weight per minute per IP (venue-hyperliquid.md section 8)
  hyperliquid: weight(1200, 60_000),
  "hyperliquid-testnet": weight(1200, 60_000),
  // Standard tier: 60 requests per rolling minute per IP and per L1; governor at 1 req/s (venue-lighter.md, rate limits)
  "lighter-304": request(60, 60_000, 1000),
  "lighter-466324": request(60, 60_000, 1000),
  "lighter-300": request(60, 60_000, 1000),
  // 2,400 weight per minute per IP; read x-mbx-used-weight-1m (venue-aster.md section 3)
  aster: weight(2400, 60_000),
  "aster-testnet": weight(2400, 60_000),
  // 10 requests per 10 s per IP; honour retry_after_seconds in the 429 body (venue-readonly.md section 1)
  variational: request(10, 10_000),
  // 1,500 weight per minute per IP, refill 25/s; honour Retry-After (venue-readonly.md section 2.3)
  arcus: weight(1500, 60_000),
  "arcus-testnet": weight(1500, 60_000),
};

/** Lighter sendTx per-L1 limit: 40 tx per minute per type (Standard), until testnet shows which limit binds. */
export const LIGHTER_L1_SUBMIT_BUDGET = request(40, 60_000);

export function budgetFor(key: BucketKey): Omit<Budget, "egress" | "venue"> {
  if (key.includes(":l1:")) return LIGHTER_L1_SUBMIT_BUDGET;
  const b = BUDGETS[key as VenueKey];
  if (!b) throw new Error(`venue-client: no budget for ${key}`);
  return b;
}

/** Highest total a lane may reach inside one window. */
export function laneCap(perWindow: number, priority: Priority): number {
  return priority === "safety" ? perWindow : Math.floor(perWindow * 0.8);
}

// ---------------- Hyperliquid info weights (venue-hyperliquid.md section 8) ----------------
export const HL_INFO_WEIGHT: Record<string, number> = {
  l2Book: 2,
  allMids: 2,
  clearinghouseState: 2,
  orderStatus: 2,
  spotClearinghouseState: 2,
  exchangeStatus: 2,
  userRole: 60,
};
export const HL_INFO_DEFAULT_WEIGHT = 20;
/** Info types that add weight per items returned: per 20 items, candleSnapshot per 60. */
export const HL_INFO_PER_ITEMS: Record<string, number> = {
  recentTrades: 20,
  historicalOrders: 20,
  userFills: 20,
  userFillsByTime: 20,
  userFunding: 20,
  userNonFundingLedgerUpdates: 20,
  fundingHistory: 20,
  userTwapSliceFills: 20,
  candleSnapshot: 60,
};

/** Weight of one HL info call. Pass `items` (rows returned) for the per-item types after the response arrives. */
export function hlInfoWeight(type: string, items = 0): number {
  const base = HL_INFO_WEIGHT[type] ?? HL_INFO_DEFAULT_WEIGHT;
  const per = HL_INFO_PER_ITEMS[type];
  return base + (per ? Math.floor(items / per) : 0);
}

/** Weight of one HL exchange action: 1 + floor(batch / 40). */
export function hlExchangeWeight(batchLength: number): number {
  return 1 + Math.floor(Math.max(0, batchLength) / 40);
}

// ---------------- Aster path weights (venue-aster.md section 2, measured from x-mbx-used-weight-1m) ----------------
export const ASTER_PATH_WEIGHT: Record<string, number> = {
  "/fapi/v3/exchangeInfo": 1,
  "/fapi/v3/premiumIndex": 1, // 10 without a symbol
  "/fapi/v3/fundingInfo": 10, // measured 10 (docs say 1)
  "/fapi/v3/fundingRate": 1,
  "/fapi/v3/ticker/24hr": 1,
  "/fapi/v3/ticker/bookTicker": 1,
  "/fapi/v3/openInterest": 1,
  "/fapi/v3/klines": 1,
  "/fapi/v3/time": 1,
  "/fapi/v3/ping": 1,
  "/fapi/v3/order": 1, // docs say 0; counted as 1 to stay conservative (orders also have per-account limits)
};

export function asterWeight(path: string, query: Record<string, string | number> = {}): number {
  if (path === "/fapi/v3/depth") {
    const limit = Number(query.limit ?? 500);
    if (limit <= 50) return 2;
    if (limit <= 100) return 5;
    if (limit <= 500) return 10;
    return 20;
  }
  if (path === "/fapi/v3/premiumIndex" && query.symbol === undefined) return 10;
  return ASTER_PATH_WEIGHT[path] ?? 1;
}

// ---------------- Arcus path weights (venue-readonly.md section 2.3) ----------------
export const ARCUS_PATH_WEIGHT: Record<string, number> = {
  "/health": 0,
  "/": 1,
  "/v1/time": 1,
  "/v1/bbo": 2,
  "/v1/mids": 2,
  "/v1/account": 2,
  "/v1/positions": 2,
  "/v1/order": 2,
  "/v1/feeTiers": 2,
  "/v1/prices": 20,
  "/v1/markets": 20,
  "/v1/markets/feeSchedules": 20,
  "/v1/trades": 20,
  "/v1/candles": 20,
  "/v1/fundingRates": 20,
  "/v1/orders": 20,
  "/v1/fills": 20,
  "/v1/l2OrderBook": 2,
};

/** Arcus weight by path prefix (path parameters such as /v1/bbo/BTC-USD map to /v1/bbo); lists add floor(items/20). */
export function arcusWeight(path: string, items = 0): number {
  const clean = path.split("?")[0]!;
  let w = ARCUS_PATH_WEIGHT[clean];
  if (w === undefined) {
    const prefix = Object.keys(ARCUS_PATH_WEIGHT)
      .filter((p) => p !== "/" && clean.startsWith(p + "/"))
      .sort((a, b) => b.length - a.length)[0];
    w = prefix ? ARCUS_PATH_WEIGHT[prefix]! : 20;
  }
  return w + Math.floor(items / 20);
}
