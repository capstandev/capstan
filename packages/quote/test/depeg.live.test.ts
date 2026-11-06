// Live read of the Robinhood Chain v3 WETH/USDG pool (eth_call only). Skips unless RHC_RPC_URL is set:
//   RHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com bun test packages/quote/test/depeg.live.test.ts
import { describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import { createPublicClient, http } from "viem";
import { createDepegReader } from "../src/depeg";

const RPC = process.env.RHC_RPC_URL;

describe("depeg live", () => {
  (RPC ? test : test.skip)(
    "pool price is a sane ETH price in USDG and the reading only flags",
    async () => {
      const rpc = createPublicClient({ transport: http(RPC!, { timeout: 15_000 }) });
      expect(await rpc.getChainId()).toBe(4663);
      const cache = memoryMarketDataCache();
      const r = createDepegReader(rpc, cache);
      const p = await r.poolPrice();
      expect(p.usdgPerEth).toBeGreaterThan(300);
      expect(p.usdgPerEth).toBeLessThan(30_000);
      expect(["twap_5m", "slot0"]).toContain(p.method);
      // with a USDC reference equal to the pool price, the reading is 0 bps
      await cache.putMark("hyperliquid:-:ETH", String(p.usdgPerEth), new Date().toISOString());
      const g = await r.usdgUsdcBps();
      expect(g!.source).toBe("uniswap_v3");
      expect(Math.abs(g!.bps)).toBeLessThan(5);
      // the Chainlink cross-check reads both proxies (eth_call) inside their 24 h + 1 h limit and sits near the peg
      const cl = await r.chainlinkUsdgUsdcBps();
      expect(cl).not.toBeNull();
      expect(Math.abs(cl!.bps)).toBeLessThan(100);
      expect(Date.now() - cl!.updatedAt).toBeLessThan(25 * 3600_000);
    },
    30_000,
  );
});
