// Depeg monitor, every 60 s: USDG/USDC from the Uniswap v3 WETH/USDG 0.01% pool on Robinhood Chain (eth_call only,
// 5-minute TWAP when the pool's observations reach back that far, else slot0) against the Hyperliquid ETH mark, and
// USDT/USDC from venue marks. Writes md:depeg:usdg-usdc and md:depeg:usdt-usdc with asOf. A failed read deletes the
// key, so readers see "unknown" at once instead of an old value (fail closed). Readings only flag comparisons.
import type { JobDef, JobDeps } from "@capstan/core";
import { createDepegReader, DEPEG_KEYS, type DepegReader, type DepegReading } from "@capstan/quote";
import { CHAINS } from "@capstan/schema";
import { createPublicClient, http } from "viem";

/** Keys live a little past the 5-minute validity so a reader can still see the age; readers enforce 5 minutes. */
export const DEPEG_TTL_MS = 10 * 60_000;

export interface DepegSink {
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}

export function redisSink(redis: { set(k: string, v: string, px: "PX", ms: number): Promise<unknown>; del(k: string): Promise<unknown> }): DepegSink {
  return {
    async set(k, v, ms) {
      await redis.set(k, v, "PX", ms);
    },
    async del(k) {
      await redis.del(k);
    },
  };
}

export async function runDepegMonitor(reader: DepegReader, sink: DepegSink): Promise<{ usdgUsdc: DepegReading | null; usdtUsdc: DepegReading | null }> {
  const usdg = await reader.usdgUsdcBps().catch(() => null);
  const usdt = await reader.usdtUsdcBps().catch(() => null);
  for (const [key, r] of [
    [DEPEG_KEYS.usdg, usdg],
    [DEPEG_KEYS.usdt, usdt],
  ] as const) {
    if (r) await sink.set(key, JSON.stringify(r), DEPEG_TTL_MS);
    else await sink.del(key);
  }
  return { usdgUsdc: usdg, usdtUsdc: usdt };
}

let reader: DepegReader | null = null;
function readerFor(deps: JobDeps): DepegReader {
  if (reader) return reader;
  if (!deps.cache) throw new Error("depeg-monitor needs the market data cache");
  const rpc = createPublicClient({ transport: http(process.env.RHC_RPC_URL || CHAINS.rhc.publicRpc, { timeout: 10_000, retryCount: 2 }) });
  reader = createDepegReader(rpc, deps.cache);
  return reader;
}

export const job: JobDef = {
  name: "depeg-monitor",
  queue: "fundingTick",
  schedule: { every: 60_000 },
  concurrency: 1,
  async handler(_job, deps) {
    if (!deps.redis) throw new Error("depeg-monitor needs Redis");
    const r = await runDepegMonitor(readerFor(deps), redisSink(deps.redis));
    if (!r.usdgUsdc || !r.usdtUsdc) deps.log.warn("depeg reading unknown", { usdg: r.usdgUsdc !== null, usdt: r.usdtUsdc !== null });
    return r;
  },
};
