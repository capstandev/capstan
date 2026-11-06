// Stablecoin depeg reader (spec 4.3, DECISIONS #30). USDG/USDC comes from the Uniswap v3 WETH/USDG 0.01% pool on
// Robinhood Chain (eth_call only) against a USDC reference (the Hyperliquid ETH mark): USDG in USDC = (USDC per ETH) /
// (USDG per ETH). The reader prefers a 5-minute observe() TWAP when the pool's observation cardinality covers the window,
// else slot0 (ORC-CARD). USDT/USDC comes from venue marks (Aster BTCUSDT against Hyperliquid BTC).
// Chainlink USDG/USD against USDC/USD moves only on 0.5% or 24 h, so it is a coarse cross-check: read on every USDG
// reading, it can raise a reading to a flag (a stale pool or a missed move) but can never lower or clear one, and on
// its own (no pool and no marks) it gives no reading at all.
// A reading only ever FLAGS a comparison: it never refuses a leg and never converts an amount.
import type { MarketDataCache } from "@capstan/core";
import { ADDRESSES } from "@capstan/schema";
import type { PublicClient } from "viem";

export interface DepegReading {
  bps: number; // (price in USDC - 1) x 10,000, two decimals
  asOf: number; // ms
  source: "uniswap_v3" | "venue_marks";
  method?: "twap_5m" | "slot0";
  /** The Chainlink cross-check when it was fresh; `raised` when it moved bps past the flag. */
  chainlink?: { bps: number; updatedAt: number; raised: boolean };
}

export interface DepegReader {
  usdgUsdcBps(): Promise<DepegReading | null>;
  usdtUsdcBps(): Promise<DepegReading | null>;
}

export const DEPEG_KEYS = { usdg: "md:depeg:usdg-usdc", usdt: "md:depeg:usdt-usdc" } as const;
/** Flag threshold. */
export const DEPEG_FLAG_BPS = 25;
/** A reading older than this is unknown (fail closed). */
export const DEPEG_MAX_AGE_MS = 5 * 60_000;
export const TWAP_WINDOW_S = 300;
/** Chainlink USDG/USD against USDC/USD: a coarse cross-check only (heartbeat 24 h + 1 h margin, deviation 0.5%). */
export const CHAINLINK_MAX_AGE_MS = 25 * 3600_000;
/** Venue marks older than this are not used for a reading. */
export const MARK_MAX_AGE_MS = 60_000;

const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ type: "uint160", name: "sqrtPriceX96" }, { type: "int24", name: "tick" }, { type: "uint16", name: "observationIndex" }, { type: "uint16", name: "observationCardinality" }, { type: "uint16", name: "observationCardinalityNext" }, { type: "uint8", name: "feeProtocol" }, { type: "bool", name: "unlocked" }] },
  { type: "function", name: "observe", stateMutability: "view", inputs: [{ type: "uint32[]", name: "secondsAgos" }], outputs: [{ type: "int56[]", name: "tickCumulatives" }, { type: "uint160[]", name: "secondsPerLiquidityCumulativeX128s" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export interface DepegReaderOptions {
  pool?: `0x${string}`;
  weth?: `0x${string}`;
  usdg?: `0x${string}`;
  /** USDC-collateral ETH mark (the reference). */
  ethUsdcMarket?: string;
  /** USDG-collateral ETH mark, used only when the pool read fails. */
  ethUsdgMarket?: string;
  btcUsdcMarket?: string;
  btcUsdtMarket?: string;
  /** Chainlink USDG/USD and USDC/USD proxies (8 decimals) for the cross-check. */
  chainlinkUsdgUsd?: `0x${string}`;
  chainlinkUsdcUsd?: `0x${string}`;
  now?: () => number;
}

const FEED_ABI = [
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80", name: "roundId" }, { type: "int256", name: "answer" }, { type: "uint256", name: "startedAt" }, { type: "uint256", name: "updatedAt" }, { type: "uint80", name: "answeredInRound" }] },
] as const;

/**
 * Raise a reading with the Chainlink cross-check: the larger of the two only when Chainlink is past the flag and
 * further from the peg. A reading is never lowered, so Chainlink can never clear a flag.
 */
export function applyChainlinkCrossCheck(r: DepegReading, cl: { bps: number; updatedAt: number } | null): DepegReading {
  if (!cl) return r;
  const raised = Math.abs(cl.bps) > DEPEG_FLAG_BPS && Math.abs(cl.bps) > Math.abs(r.bps);
  return { ...r, bps: raised ? cl.bps : r.bps, chainlink: { ...cl, raised } };
}

const round2 = (x: number) => {
  const v = Math.round(x * 100) / 100;
  return v === 0 ? 0 : v;
};

/**
 * USDG per WETH from the raw v3 price (token1 per token0 in base units). WETH has 18 decimals, USDG 6:
 * token0 WETH: USDG per WETH = raw x 10^12; token0 USDG: USDG per WETH = 10^12 / raw.
 */
function usdgPerEthFromRaw(raw: number, wethIsToken0: boolean): number {
  return wethIsToken0 ? raw * 1e12 : 1e12 / raw;
}

export function usdgPerEthFromTick(tick: number, wethIsToken0: boolean): number {
  return usdgPerEthFromRaw(Math.pow(1.0001, tick), wethIsToken0);
}

export function usdgPerEthFromSqrt(sqrtPriceX96: bigint, wethIsToken0: boolean): number {
  // raw = (sqrt / 2^96)^2, kept exact to 36 decimals in bigint before it becomes a number
  const q = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 36n) >> 192n;
  return usdgPerEthFromRaw(Number(q) / 1e36, wethIsToken0);
}

/** Price of X in USDC, in bps away from 1: (usdcPerUnit / xPerUnit - 1) x 10,000. */
export function bpsFromPrices(usdcPerUnit: number, xPerUnit: number): number {
  return round2((usdcPerUnit / xPerUnit - 1) * 10_000);
}

export function createDepegReader(
  rpc: Pick<PublicClient, "readContract">,
  cache: Pick<MarketDataCache, "getMark">,
  o: DepegReaderOptions = {},
): DepegReader & { poolPrice(): Promise<{ usdgPerEth: number; method: "twap_5m" | "slot0" }>; chainlinkUsdgUsdcBps(): Promise<{ bps: number; updatedAt: number } | null> } {
  const now = o.now ?? Date.now;
  const pool = (o.pool ?? ADDRESSES.v3WethUsdg001.address) as `0x${string}`;
  const weth = (o.weth ?? ADDRESSES.wethRhc.address).toLowerCase();
  const ethUsdc = o.ethUsdcMarket ?? "hyperliquid:-:ETH";
  const ethUsdg = o.ethUsdgMarket ?? "lighter-rh:-:ETH";
  const btcUsdc = o.btcUsdcMarket ?? "hyperliquid:-:BTC";
  const btcUsdt = o.btcUsdtMarket ?? "aster:-:BTCUSDT";
  const clUsdg = (o.chainlinkUsdgUsd ?? ADDRESSES.chainlinkUsdgUsd.address) as `0x${string}`;
  const clUsdc = (o.chainlinkUsdcUsd ?? ADDRESSES.chainlinkUsdcUsd.address) as `0x${string}`;
  let wethIsToken0: boolean | null = null;

  /** One feed's answer when it is positive and inside CHAINLINK_MAX_AGE_MS, else null. */
  async function feed(address: `0x${string}`): Promise<{ v: number; updatedAt: number } | null> {
    const r = (await rpc.readContract({ address, abi: FEED_ABI, functionName: "latestRoundData" })) as readonly [bigint, bigint, bigint, bigint, bigint];
    const answer = r[1];
    const updatedAt = Number(r[3]) * 1000;
    if (answer <= 0n || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
    const age = now() - updatedAt;
    if (age > CHAINLINK_MAX_AGE_MS || age < -60_000) return null;
    return { v: Number(answer) / 1e8, updatedAt };
  }

  /** USDG in USDC from Chainlink (USDG/USD over USDC/USD); null when either feed is unreadable or stale. */
  async function chainlinkUsdgUsdcBps(): Promise<{ bps: number; updatedAt: number } | null> {
    try {
      const [g, c] = await Promise.all([feed(clUsdg), feed(clUsdc)]);
      if (!g || !c) return null;
      return { bps: bpsFromPrices(g.v, c.v), updatedAt: Math.min(g.updatedAt, c.updatedAt) };
    } catch {
      return null;
    }
  }

  async function freshMark(id: string): Promise<{ v: number; asOf: number } | null> {
    const m = await cache.getMark(id);
    if (!m) return null;
    const asOf = Date.parse(m.asOf);
    if (!Number.isFinite(asOf) || now() - asOf > MARK_MAX_AGE_MS) return null;
    const v = Number(m.mark);
    return v > 0 ? { v, asOf } : null;
  }

  async function poolPrice(): Promise<{ usdgPerEth: number; method: "twap_5m" | "slot0" }> {
    if (wethIsToken0 === null) {
      const t0 = (await rpc.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" })) as string;
      wethIsToken0 = t0.toLowerCase() === weth;
    }
    const s0 = (await rpc.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" })) as readonly [bigint, number, number, number, number, number, boolean];
    const cardinality = Number(s0[3]);
    if (cardinality > 1) {
      try {
        const [ticks] = (await rpc.readContract({ address: pool, abi: POOL_ABI, functionName: "observe", args: [[TWAP_WINDOW_S, 0]] })) as readonly [readonly bigint[], readonly bigint[]];
        const delta = ticks[1]! - ticks[0]!;
        // arithmetic mean tick, rounded toward minus infinity like the v3 OracleLibrary
        let mean = delta / BigInt(TWAP_WINDOW_S);
        if (delta < 0n && delta % BigInt(TWAP_WINDOW_S) !== 0n) mean -= 1n;
        return { usdgPerEth: usdgPerEthFromTick(Number(mean), wethIsToken0), method: "twap_5m" };
      } catch {
        // observations do not reach back 5 minutes ("OLD"): fall back to the spot price
      }
    }
    return { usdgPerEth: usdgPerEthFromSqrt(s0[0], wethIsToken0), method: "slot0" };
  }

  async function primaryUsdg(): Promise<DepegReading | null> {
    const ref = await freshMark(ethUsdc);
    if (!ref) return null; // no USDC reference: unknown, never assumed pegged
    try {
      const p = await poolPrice();
      return { bps: bpsFromPrices(ref.v, p.usdgPerEth), asOf: Math.min(now(), ref.asOf), source: "uniswap_v3", method: p.method };
    } catch {
      const g = await freshMark(ethUsdg);
      if (!g) return null;
      return { bps: bpsFromPrices(ref.v, g.v), asOf: Math.min(ref.asOf, g.asOf), source: "venue_marks" };
    }
  }

  return {
    poolPrice,
    chainlinkUsdgUsdcBps,
    async usdgUsdcBps() {
      const r = await primaryUsdg();
      if (!r) return null; // Chainlink alone never makes a reading (it cannot see a 25 bps move)
      return applyChainlinkCrossCheck(r, await chainlinkUsdgUsdcBps());
    },
    async usdtUsdcBps() {
      const a = await freshMark(btcUsdc);
      const b = await freshMark(btcUsdt);
      if (!a || !b) return null;
      return { bps: bpsFromPrices(a.v, b.v), asOf: Math.min(a.asOf, b.asOf), source: "venue_marks" };
    },
  };
}

/** The API side: readings the depeg-monitor job wrote. A missing key is null (unknown). */
export function cachedDepegReader(redis: { get(k: string): Promise<string | null> }): DepegReader {
  const read = async (k: string): Promise<DepegReading | null> => {
    const s = await redis.get(k);
    if (!s) return null;
    try {
      const v = JSON.parse(s) as DepegReading;
      return typeof v.bps === "number" && typeof v.asOf === "number" ? v : null;
    } catch {
      return null;
    }
  };
  return { usdgUsdcBps: () => read(DEPEG_KEYS.usdg), usdtUsdcBps: () => read(DEPEG_KEYS.usdt) };
}

