// R5 (todo 32): an unpaid capstan_spread_scan returns the PaymentRequired shape (isError, structuredContent and text);
// a paid retry with _meta["x402/payment"] succeeds through an in-process facilitator and returns
// _meta["x402/payment-response"]. Once paid, the MCP server calls the priced API route as the internal caller; without
// that the API's own x402 gate answers 402. With payments off, a paid call is never served free.
import { describe, expect, test } from "bun:test";
import type { RouteSpec } from "@capstan/core";
import { acceptsFor, clientSpendControls, createResourceServer, NETWORKS, railDefs, type X402State } from "@capstan/x402";
import { x402Client } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { labelAccount } from "../../../packages/x402/test/helpers/chain";
import { apiKeyCheck, x402Verifier } from "../../api/src/auth";
import { callTool, localApi, mcp, rpc } from "./helpers";

const payer = labelAccount("mcp-x402-payer");
const defs = railDefs("testnet");
const state = (): X402State => ({
  usdgEip3009: { "4663": false, "46630": false },
  payTo: { evm: "0x00000000000000000000000000000000000000aa", sol: "So1PayTo1111111111111111111111111111111111" },
  tokens: { "base-usdc": { asset: defs["base-usdc"].asset, decimals: 6, name: defs["base-usdc"].domain!.name, version: defs["base-usdc"].domain!.version } },
  droppedRails: ["rhc-usdg-permit2", "rhc-usdg-eip3009"],
});
const INTERNAL = "internal-token-for-the-mcp-host-0000000";
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
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORKS.baseSepolia }], extensions: [], signers: { "eip155:*": ["0x00000000000000000000000000000000000000f1"] } };
  },
};

describe("x402 over MCP", () => {
  test("paid-tool", async () => {
    const scan: RouteSpec = { method: "GET", path: "/spreads/scan", auth: "x402", priced: { usd: "0.02" }, handler: (c) => c.json({ pairs: [{ a: "hyperliquid:-:ETH", b: "lighter-mainnet:-:ETH", breakevenHours: 12 }] }) };
    let gateHits = 0;
    const { api, seen } = await localApi([scan], {
      verifiers: { x402: x402Verifier({ check: apiKeyCheck({ verify: async () => null }), spend: async () => false, internalToken: INTERNAL }) },
      // the API's own gate: anyone not paid by credits or the internal caller gets a 402
      payment: async (c) => (gateHits++, c.json({ error: { code: "X402_PAYMENT_REQUIRED", message: "Payment required." } }, 402)),
    });
    const rs = createResourceServer(facilitator);
    await rs.initialize();
    const app = mcp(api, { payments: { resourceServer: rs, accepts: (t) => acceptsFor({ usd: t.priced!.usd, description: t.name }, state(), "testnet"), internalToken: INTERNAL } });

    // unpaid: the PaymentRequired shape, and no API call at all
    const before = seen.length;
    const unpaid = await callTool(app, "capstan_spread_scan", { asset: "CR:ETH" });
    expect(unpaid.isError).toBe(true);
    const required = unpaid.structuredContent as unknown as PaymentRequired;
    expect(required.x402Version).toBe(2);
    expect(required.accepts[0]!.amount).toBe("20000");
    expect(JSON.parse(unpaid.content[0]!.text)).toMatchObject({ x402Version: 2 });
    expect(seen.length).toBe(before);

    // paid retry: the tool runs, the API is called once as the internal caller, settlement is returned
    const client = new x402Client((_v, reqs) => reqs[0]!);
    client.register(NETWORKS.baseSepolia, new ExactEvmScheme(payer));
    client.setSpendControls(clientSpendControls("testnet", "1"));
    const payload = await client.createPaymentPayload(required);
    const paid = (await rpc(app, "tools/call", { name: "capstan_spread_scan", arguments: { asset: "CR:ETH" }, _meta: { "x402/payment": payload } })).body.result;
    expect(paid.isError).toBeUndefined();
    expect(paid.structuredContent).toEqual({ pairs: [{ a: "hyperliquid:-:ETH", b: "lighter-mainnet:-:ETH", breakevenHours: 12 }] });
    expect(paid._meta["x402/payment-response"]).toMatchObject({ success: true });
    expect(settles).toBe(1);
    expect(gateHits).toBe(0);
    expect(seen.at(-1)!.headers.get("x-capstan-internal")).toBe(INTERNAL);

    // the owner's own risk stays free; third-party addresses are paid
    const third = await callTool(app, "capstan_risk", { addresses: [{ venue: "hyperliquid", owner: "0x0000000000000000000000000000000000000001" }] });
    expect(third.isError).toBe(true);
    expect((third.structuredContent as unknown as PaymentRequired).accepts[0]!.amount).toBe("10000");

    // payments off: a paid call answers "payments unavailable", never the data
    const off = mcp(api);
    const r = await callTool(off, "capstan_spread_scan", { asset: "CR:ETH" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: { code: "X402_PAYMENTS_UNAVAILABLE" } });
  });
});
