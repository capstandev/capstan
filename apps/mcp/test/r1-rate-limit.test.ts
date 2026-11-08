// Security review r1 review-r1:9 F-1: the MCP server had no rate limit (MCP_RATE_LIMIT_PER_MIN was never read), so one
// zero-balance x402 payload, replayed in JSON-RPC batches of 100 paid tool calls, drove unlimited facilitator /verify
// calls (each one several RPC reads). After the fix a batch carries at most 5 paid calls, a payload the facilitator
// refused is refused again without another verify, and every IP has a per-minute message budget (429 past it).
import { describe, expect, test } from "bun:test";
import { acceptsFor, clientSpendControls, createResourceServer, NETWORKS, railDefs, type X402State } from "@capstan/x402";
import { x402Client } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { labelAccount } from "../../../packages/x402/test/helpers/chain";
import { callTool, localApi, mcp, MCP_HOST } from "./helpers";

const payer = labelAccount("r1-mcp-zero-balance");
const defs = railDefs("testnet");
const state = (): X402State => ({
  usdgEip3009: { "4663": false, "46630": false },
  payTo: { evm: "0x00000000000000000000000000000000000000aa", sol: "So1PayTo1111111111111111111111111111111111" },
  tokens: { "base-usdc": { asset: defs["base-usdc"].asset, decimals: 6, name: defs["base-usdc"].domain!.name, version: defs["base-usdc"].domain!.version } },
  droppedRails: ["rhc-usdg-permit2", "rhc-usdg-eip3009"],
});
let verifies = 0;
// the payer holds nothing: every verify is refused (and on the real facilitator costs a simulate plus a multicall)
const facilitator: FacilitatorClient = {
  async verify() {
    verifies++;
    await Bun.sleep(5);
    return { isValid: false, invalidReason: "insufficient_funds", payer: payer.address };
  },
  async settle() {
    throw new Error("never settled");
  },
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORKS.baseSepolia }], extensions: [], signers: { "eip155:*": ["0x00000000000000000000000000000000000000f1"] } };
  },
};

const post = (app: { request(u: string, i: RequestInit): Response | Promise<Response> }, body: unknown, ip: string) =>
  app.request(`http://${MCP_HOST}/mcp`, { method: "POST", headers: { host: MCP_HOST, "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": ip }, body: JSON.stringify(body) });

describe("r1 F-1: MCP rate limits", () => {
  test("batches of paid calls with one refused payload never fan out to the facilitator", async () => {
    const { api } = await localApi([]);
    const rs = createResourceServer(facilitator);
    await rs.initialize();
    const app = mcp(api, { payments: { resourceServer: rs, accepts: (t) => acceptsFor({ usd: t.priced!.usd, description: t.name }, state(), "testnet"), internalToken: "internal-token-for-the-mcp-host-0000000" } });
    const unpaid = await callTool(app, "capstan_spread_scan", { asset: "CR:ETH" });
    const client = new x402Client((_v, reqs) => reqs[0]!);
    client.register(NETWORKS.baseSepolia, new ExactEvmScheme(payer));
    client.setSpendControls(clientSpendControls("testnet", "1"));
    const payload: PaymentPayload = await client.createPaymentPayload(unpaid.structuredContent as unknown as PaymentRequired);
    const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "capstan_spread_scan", arguments: { asset: "CR:ETH" }, _meta: { "x402/payment": payload } } });

    verifies = 0;
    // one HTTP request with 100 paid calls: refused whole, no verify at all
    await post(app, Array.from({ length: 100 }, (_, i) => call(i)), "198.51.100.1");
    expect(verifies).toBe(0);
    // small batches from many IPs, the same refused payload: one facilitator verify in all
    for (let i = 0; i < 5; i++) await post(app, Array.from({ length: 5 }, (_, j) => call(i * 10 + j)), `198.51.100.${10 + i}`);
    expect(verifies).toBe(1);
  });

  test("one IP gets 429 past its per-minute budget", async () => {
    const { api } = await localApi([]);
    const app = mcp(api);
    const statuses: number[] = [];
    for (let i = 0; i < 80; i++) statuses.push((await post(app, { jsonrpc: "2.0", id: i, method: "tools/list" }, "198.51.100.200")).status);
    expect(statuses.filter((s) => s === 429).length).toBe(20);
    // another IP is not affected
    expect((await post(app, { jsonrpc: "2.0", id: 999, method: "tools/list" }, "198.51.100.201")).status).toBe(200);
  });
});
