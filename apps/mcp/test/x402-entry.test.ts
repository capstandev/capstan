// Todo 32 production entry: mcpAppFromEnv (what `bun apps/mcp/src/index.ts` serves) builds the x402 payments for paid
// tools from the environment. With X402_ENABLED, payTo and CAPSTAN_INTERNAL_TOKEN set, an unpaid capstan_spread_scan
// answers PaymentRequired with the rails read at boot, and a paid retry runs once and reaches the API as the internal
// caller. With any of them missing, a paid tool answers "payments unavailable" and is never served free. Before this
// fix the production entry never built payments, so paid tools always refused.
import { describe, expect, test } from "bun:test";
import { loadConfig, type RouteSpec } from "@capstan/core";
import { clientSpendControls, NETWORKS, railOf } from "@capstan/x402";
import { x402Client } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { labelAccount } from "../../../packages/x402/test/helpers/chain";
import { fakeTestnetChains } from "../../../packages/x402/test/helpers/fake-chain";
import { apiKeyCheck, x402Verifier } from "../../api/src/auth";
import { mcpAppFromEnv } from "../src/index";
import { callTool, localApi, MCP_HOST, rpc } from "./helpers";

const payer = labelAccount("mcp-entry-payer");
const INTERNAL = "internal-token-for-the-mcp-entry-000000";
const ENV = { X402_PAY_TO_EVM: "0x00000000000000000000000000000000000000aa", X402_PAY_TO_SOL: "So1PayTo1111111111111111111111111111111111", CAPSTAN_INTERNAL_TOKEN: INTERNAL, MCP_ALLOWED_HOSTS: MCP_HOST };
let settles = 0;
const facilitator: FacilitatorClient = {
  async verify(p: PaymentPayload) {
    return { isValid: true, payer: (p.payload as { authorization?: { from?: string } }).authorization?.from ?? payer.address };
  },
  async settle(_p: PaymentPayload, r: PaymentRequirements) {
    settles++;
    return { success: true, transaction: `0x${settles.toString(16).padStart(64, "0")}`, network: r.network, payer: payer.address };
  },
  async getSupported() {
    return { kinds: [NETWORKS.baseSepolia, NETWORKS.rhcTestnet].map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: { "eip155:*": ["0x00000000000000000000000000000000000000f1"] } };
  },
};
const quiet = { info() {}, warn() {} };

describe("MCP production entry", () => {
  test("paid-tools-wired", async () => {
    const scan: RouteSpec = { method: "GET", path: "/spreads/scan", auth: "x402", priced: { usd: "0.02" }, handler: (c) => c.json({ pairs: [] }) };
    let gateHits = 0;
    const { api, seen } = await localApi([scan], {
      verifiers: { x402: x402Verifier({ check: apiKeyCheck({ verify: async () => null }), spend: async () => false, internalToken: INTERNAL }) },
      payment: async (c) => (gateHits++, c.json({ error: { code: "X402_PAYMENT_REQUIRED", message: "Payment required." } }, 402)),
    });
    const cfg = loadConfig("mcp", { CAPSTAN_NETWORK: "testnet", X402_ENABLED: "1" });
    const { app, paidTools } = await mcpAppFromEnv(cfg, ENV, { api, facilitator, clients: fakeTestnetChains(true).clients, detections: async () => ({ "4663": false, "46630": true }), log: quiet });
    expect(paidTools).toBe(true);

    // unpaid: PaymentRequired with the boot rails (Base USDC first, RHC USDG eip3009 offered because detection passed)
    const before = seen.length;
    const unpaid = await callTool(app, "capstan_spread_scan", { asset: "CR:ETH" });
    expect(unpaid.isError).toBe(true);
    const required = unpaid.structuredContent as unknown as PaymentRequired;
    expect(required.x402Version).toBe(2);
    expect(required.accepts.map((a) => railOf(a, "testnet"))).toEqual(["base-usdc", "rhc-usdg-permit2", "rhc-usdg-eip3009"]);
    expect(required.accepts[0]!.amount).toBe("20000");
    expect(seen.length).toBe(before);

    // paid retry: settles once, the API sees the internal caller, not its own 402 gate
    const client = new x402Client((_v, reqs) => reqs[0]!);
    client.register(NETWORKS.baseSepolia, new ExactEvmScheme(payer));
    client.setSpendControls(clientSpendControls("testnet", "1"));
    const payload = await client.createPaymentPayload(required);
    const paid = (await rpc(app, "tools/call", { name: "capstan_spread_scan", arguments: { asset: "CR:ETH" }, _meta: { "x402/payment": payload } })).body.result;
    expect(paid.isError).toBeUndefined();
    expect(paid.structuredContent).toEqual({ pairs: [] });
    expect(paid._meta["x402/payment-response"]).toMatchObject({ success: true });
    expect(settles).toBe(1);
    expect(gateHits).toBe(0);
    expect(seen.at(-1)!.headers.get("x-capstan-internal")).toBe(INTERNAL);
  });

  test("fails-closed-when-off", async () => {
    const { api, seen } = await localApi([{ method: "GET", path: "/spreads/scan", auth: "x402", priced: { usd: "0.02" }, handler: (c) => c.json({ pairs: [] }) }]);
    const on = loadConfig("mcp", { CAPSTAN_NETWORK: "testnet", X402_ENABLED: "1" });
    const cases: [ReturnType<typeof loadConfig<"mcp">>, Record<string, string>][] = [
      [loadConfig("mcp", { CAPSTAN_NETWORK: "testnet" }), ENV], // X402_ENABLED off
      [on, { ...ENV, X402_PAY_TO_SOL: "" }], // payTo missing
      [on, { ...ENV, CAPSTAN_INTERNAL_TOKEN: "short" }], // no usable internal token
    ];
    for (const [cfg, env] of cases) {
      const { app, paidTools } = await mcpAppFromEnv(cfg, env, { api, facilitator, clients: fakeTestnetChains(true).clients, log: quiet });
      expect(paidTools).toBe(false);
      const before = seen.length;
      const r = await callTool(app, "capstan_spread_scan", { asset: "CR:ETH" });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({ error: { code: "X402_PAYMENTS_UNAVAILABLE" } });
      expect(seen.length).toBe(before); // never reached the API
    }
    // payments on but no rail readable (every chain down): unavailable, never free
    const dead = { call: async () => Promise.reject(new Error("down")), getGasPrice: async () => Promise.reject(new Error("down")) };
    const { app } = await mcpAppFromEnv(on, ENV, { api, facilitator, clients: { [NETWORKS.baseSepolia]: dead, [NETWORKS.rhcTestnet]: dead }, log: quiet });
    const r = await callTool(app, "capstan_spread_scan", { asset: "CR:ETH" });
    expect(r.structuredContent).toMatchObject({ error: { code: "X402_PAYMENTS_UNAVAILABLE" } });
  });
});
