// r1:3 F7: Hono answers HEAD by running the GET route with c.req.method still "HEAD", so a gate that matched only
// "GET" let HEAD run priced handlers unpaid. HEAD on a priced GET route must answer 405 and never reach the handler.
import { describe, expect, test } from "bun:test";
import type { FacilitatorClient } from "@x402/core/server";
import { Hono } from "hono";
import type { X402State } from "../src/accepts";
import { createResourceServer, paymentGate } from "../src/gate";
import { NETWORKS, railDefs } from "../src/networks";

const defs = railDefs("testnet");
const tok = (id: keyof typeof defs) => ({ asset: defs[id].asset, decimals: 6, name: defs[id].domain!.name, version: defs[id].domain!.version });
const state = (): X402State => ({
  usdgEip3009: { "4663": false, "46630": true },
  payTo: { evm: "0x00000000000000000000000000000000000000aa", sol: "So1PayTo1111111111111111111111111111111111" },
  tokens: { "base-usdc": tok("base-usdc"), "rhc-usdg-permit2": tok("rhc-usdg-permit2"), "rhc-usdg-eip3009": tok("rhc-usdg-eip3009") },
});
const facilitator: FacilitatorClient = {
  async verify() {
    return { isValid: false, invalidReason: "unused" };
  },
  async settle() {
    return { success: false, errorReason: "unused", transaction: "", network: NETWORKS.baseSepolia };
  },
  async getSupported() {
    return { kinds: [NETWORKS.baseSepolia, NETWORKS.rhcTestnet].map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: {} };
  },
};

describe("HEAD on priced routes (r1:3 F7)", () => {
  test("HEAD on a priced GET route answers 405 with Allow: GET and the handler never runs", async () => {
    let hits = 0;
    const app = new Hono();
    app.use("*", paymentGate({ "GET /v1/spreads/scan": { usd: "0.01", description: "scan" }, "GET /v1/history/:id": { usd: "0.05", perRows: 1000, description: "rows" } }, createResourceServer(facilitator), { env: "testnet", state }));
    app.get("/v1/spreads/scan", (c) => (hits++, c.json({ ok: true })));
    app.get("/v1/history/:id", (c) => (hits++, c.json({ rows: [] })));
    app.get("/v1/markets", (c) => c.json({ free: true }));
    for (const path of ["/v1/spreads/scan", "/v1/history/abc?limit=10"]) {
      const r = await app.request(path, { method: "HEAD" });
      expect(r.status).toBe(405);
      expect(r.headers.get("Allow")).toBe("GET");
    }
    expect(hits).toBe(0);
    // free routes still answer HEAD
    expect((await app.request("/v1/markets", { method: "HEAD" })).status).toBe(200);
  });
});
