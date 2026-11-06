// Hyperliquid catalog source: every core and HIP-3 market (delisted ones included, raw universe index kept) and the
// perpDexs list with live market counts. Markets are always returned non-executable; only a review turns one on.
import type { MarketSource } from "@capstan/catalog";
import { createRedis } from "@capstan/core";
import { createHlRuntime, type HlMarket, type HlRuntime } from "@capstan/adapter-hyperliquid";

let rt: HlRuntime | null = null;
let last: { at: number; markets: HlMarket[] } | null = null;

function runtime(): HlRuntime {
  if (!rt) rt = createHlRuntime(process.env, { redis: process.env.REDIS_URL ? createRedis(process.env.REDIS_URL, { lazyConnect: true }) : null });
  return rt;
}

/** listDexes runs right after listMarkets in the same sync; reuse that read for 60 s. */
async function markets(): Promise<HlMarket[]> {
  if (last && Date.now() - last.at < 60_000) return last.markets;
  const m = await runtime().reader.listMarkets();
  last = { at: Date.now(), markets: m };
  return m;
}

export function hyperliquidSource(r?: HlRuntime): MarketSource {
  const get = r ? () => r.reader.listMarkets() : markets;
  return {
    venue: "hyperliquid",
    async listMarkets() {
      return (await get()).map((m) => ({ ...m, executable: false }));
    },
    async listDexes() {
      const [dexes, ms] = await Promise.all([(r ?? runtime()).reader.perpDexs(), get()]);
      return dexes
        .filter((d) => d.name !== null)
        .map((d) => ({ dex: d.name as string, index: d.index, liveMarkets: ms.filter((m) => m.dex === d.name && m.status !== "delisted").length }));
    },
  };
}

export const source: MarketSource = hyperliquidSource();
