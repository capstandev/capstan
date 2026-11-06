// R1: detection against live USDG (read-only eth_call) is supported on 4663 and 46630, and never sends version() or
// eip712Domain() (a spy on the transport records every selector). Skips without RHC_RPC_URL / RHC_TESTNET_RPC_URL.
import { describe, expect, test } from "bun:test";
import { createPublicClient, http } from "viem";
import { detectEip3009, FORBIDDEN_SELECTORS } from "../src/detect";
import { USDG_TARGETS } from "../src/detections";
import { readTokenInfo } from "../src/tokens";

const M = process.env.RHC_RPC_URL;
const T = process.env.RHC_TESTNET_RPC_URL;

function spied(url: string) {
  const selectors: string[] = [];
  const client = createPublicClient({
    transport: http(url, {
      retryCount: 3,
      onFetchRequest: async (req) => {
        const body = (await req.clone().json()) as { params?: [{ data?: string }] } | { params?: [{ data?: string }] }[];
        for (const b of Array.isArray(body) ? body : [body]) {
          const data = b.params?.[0]?.data;
          if (typeof data === "string") selectors.push(data.slice(0, 10));
        }
      },
    }),
  });
  return { client, selectors };
}

(M && T ? describe : describe.skip)("live USDG detection", () => {
  test("usdg-both-nets", async () => {
    for (const [chain, url] of [["4663", M!], ["46630", T!]] as const) {
      const { client, selectors } = spied(url);
      const tgt = USDG_TARGETS[chain];
      const r = await detectEip3009(client, tgt.token, { name: "Global Dollar", version: "1", chainId: tgt.chainId });
      expect(r.supported, `${chain}: ${r.reason}`).toBe(true);
      const info = await readTokenInfo(client, tgt.token, tgt.chainId, { hardVersion: "1", expectName: "Global Dollar" });
      expect(info.decimals).toBe(6);
      expect(selectors.length).toBeGreaterThanOrEqual(3);
      expect(selectors).not.toContain(FORBIDDEN_SELECTORS.version);
      expect(selectors).not.toContain(FORBIDDEN_SELECTORS.eip712Domain);
    }
  }, 60_000);
});
