// Boot state (REL-3 at boot): token facts read from chain, rail costs from live gas price x fork gas x the RHC
// Chainlink ETH/USD; a stale feed or an unreadable token drops the rail (fail closed). Live part skips without RPCs.
import { describe, expect, test } from "bun:test";
import { createPublicClient, encodeAbiParameters, http } from "viem";
import { buildX402State, railStateLoader, readEthUsd, type BootClient } from "../src/boot";
import { acceptsFor, railOf } from "../src/accepts";
import { NETWORKS } from "../src/networks";

const ROUTES = { forecast: { usd: "0.01", description: "f" }, scan: { usd: "0.02", description: "s" } };
const PAY = { evm: "0x00000000000000000000000000000000000000aa" as const, sol: "So1PayTo1111111111111111111111111111111111" };

function feedClient(answer: bigint, updatedAt: number): BootClient {
  return {
    call: async () => ({ data: encodeAbiParameters([{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], [1n, answer, 0n, BigInt(updatedAt), 1n]) }) as never,
    getGasPrice: async () => 1n,
  };
}

describe("boot state", () => {
  test("eth-usd feed fails closed", async () => {
    const now = 1_800_000_000;
    expect(await readEthUsd(feedClient(3000_00000000n, now - 60), now)).toBe(3000);
    expect(await readEthUsd(feedClient(3000_00000000n, now - 26 * 3600), now)).toBeNull();
    expect(await readEthUsd(feedClient(0n, now), now)).toBeNull();
    expect(await readEthUsd({ call: async () => Promise.reject(new Error("down")) }, now)).toBeNull();
  });

  test("unreadable chain drops every EVM rail", async () => {
    const dead: BootClient = { call: async () => Promise.reject(new Error("down")), getGasPrice: async () => Promise.reject(new Error("down")) };
    const alerts: { kind: string }[] = [];
    const { state, economics } = await buildX402State({
      env: "testnet",
      routes: ROUTES,
      clients: { [NETWORKS.baseSepolia]: dead, [NETWORKS.rhcTestnet]: dead },
      usdgEip3009: { "4663": false, "46630": true },
      payTo: PAY,
      solFeePayer: "FeePayer11111111111111111111111111111111111",
      alert: (a) => void alerts.push(a),
    });
    expect(economics.dropped).toEqual(["base-usdc", "rhc-usdg-permit2", "rhc-usdg-eip3009"]);
    expect(alerts.filter((a) => a.kind === "x402.token_facts_failed").length).toBe(2);
    expect(acceptsFor(ROUTES.forecast, state, "testnet").map((a) => railOf(a, "testnet"))).toEqual(["solana-usdc"]);
  });

  test("rail state loader re-reads detections and fails closed", async () => {
    let t = 0;
    let calls = 0;
    let flags: () => Promise<{ "4663": boolean; "46630": boolean }> = async () => ({ "4663": false, "46630": true });
    const alerts: string[] = [];
    const dead: BootClient = { call: async () => Promise.reject(new Error("down")), getGasPrice: async () => Promise.reject(new Error("down")) };
    const l = railStateLoader({ env: "testnet", routes: ROUTES, clients: { [NETWORKS.rhcTestnet]: dead }, payTo: PAY, detections: () => (calls++, flags()), refreshMs: 1000, now: () => t, alert: (a) => void alerts.push(a.kind) });
    expect((await l.load()).usdgEip3009).toEqual({ "4663": false, "46630": true });
    flags = async () => Promise.reject(new Error("db down"));
    expect((await l.load()).usdgEip3009["46630"]).toBe(true); // cached inside the refresh window
    expect(calls).toBe(1);
    t = 1000;
    expect((await l.load()).usdgEip3009).toEqual({ "4663": false, "46630": false }); // unreadable = absent
    expect(alerts).toContain("x402.detections_unreadable");
    expect(l.current()?.usdgEip3009["46630"]).toBe(false);
  });

  const M = process.env.RHC_RPC_URL;
  const B = process.env.BASE_RPC_URL;
  (M && B ? test : test.skip)("live mainnet boot reads facts and applies the 50% rule to live costs", async () => {
    const rhc = createPublicClient({ transport: http(M!) });
    const base = createPublicClient({ transport: http(B!) });
    const { state, economics } = await buildX402State({ env: "mainnet", routes: ROUTES, clients: { [NETWORKS.rhc]: rhc, [NETWORKS.base]: base }, usdgEip3009: { "4663": true, "46630": true }, payTo: PAY });
    expect(state.tokens?.["base-usdc"]).toMatchObject({ name: "USD Coin", version: "2", decimals: 6 });
    expect(state.tokens?.["rhc-usdg-permit2"]).toMatchObject({ name: "Global Dollar", version: "1", decimals: 6 });
    console.log("live settle costs (USD):", JSON.stringify(economics.costs));
    for (const rail of ["base-usdc", "rhc-usdg-permit2", "rhc-usdg-eip3009"] as const) {
      const c = economics.costs[rail];
      expect(typeof c).toBe("number");
      expect(economics.dropped.includes(rail)).toBe(c! > economics.maxLimitUsd);
      expect(economics.limited.includes(rail)).toBe(c! > economics.limitUsd && c! <= economics.maxLimitUsd);
    }
    // no Solana sponsor configured: that rail has no cost and is dropped
    expect(economics.dropped).toContain("solana-usdc");
  }, 60_000);
});
