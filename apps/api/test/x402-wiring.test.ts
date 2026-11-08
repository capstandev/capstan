// R3 (todo 29): exactly five priced routes (/funding/forecast $0.01, /spreads/scan $0.02, /risk/snapshot $0.01,
// /risk/liq-heatmap $0.02, /history/funding $0.05 per 1,000 rows) answer 402 without payment and 200 with a valid one,
// through the real x402 gate (todo 33) and an in-process facilitator; the credit top-ups are listed separately. An API
// key with credits pays from credits; a facilitator that is down makes priced routes 503 and leaves free routes alone.
import { describe, expect, test } from "bun:test";
import type { RouteSpec } from "@capstan/core";
import { clientSpendControls, createResourceServer, NETWORKS, paymentGate, railDefs, type X402State } from "@capstan/x402";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { labelAccount } from "../../../packages/x402/test/helpers/chain";
import { discoverRoutes } from "../src/app";
import { apiKeyCheck, x402Verifier } from "../src/auth";
import { guardedPayment, pricedRoutes } from "../src/auth/env";
import { smallApp } from "./gw-helpers";

const payer = labelAccount("gateway-payer");
const defs = railDefs("testnet");
const state = (): X402State => ({
  usdgEip3009: { "4663": false, "46630": false },
  payTo: { evm: "0x00000000000000000000000000000000000000aa", sol: "So1PayTo1111111111111111111111111111111111" },
  tokens: { "base-usdc": { asset: defs["base-usdc"].asset, decimals: 6, name: defs["base-usdc"].domain!.name, version: defs["base-usdc"].domain!.version } },
  droppedRails: ["rhc-usdg-permit2", "rhc-usdg-eip3009"],
});

let settles = 0;
const facilitator = (down = false): FacilitatorClient => ({
  async verify(p: PaymentPayload) {
    if (down) throw new Error("facilitator down");
    return { isValid: true, payer: (p.payload as { authorization?: { from?: string } }).authorization?.from ?? payer.address };
  },
  async settle(_p: PaymentPayload, r: PaymentRequirements) {
    settles++;
    return { success: true, transaction: `0x${settles.toString(16).padStart(64, "0")}`, network: r.network, payer: payer.address };
  },
  async getSupported() {
    if (down) throw new Error("facilitator down");
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORKS.baseSepolia }], extensions: [], signers: { "eip155:*": ["0x00000000000000000000000000000000000000f1"] } };
  },
});

export const PRICED = {
  "GET /v1/funding/forecast": "0.01",
  "GET /v1/spreads/scan": "0.02",
  "POST /v1/risk/snapshot": "0.01",
  "GET /v1/risk/liq-heatmap": "0.02",
  "GET /v1/history/funding": "0.05",
};

describe("x402 wiring", () => {
  test("exactly-five", async () => {
    const specs = (await discoverRoutes()).map((r) => r.spec);
    const priced = pricedRoutes(specs);
    const topups = Object.keys(priced).filter((k) => k.startsWith("POST /v1/credits/topup/"));
    expect(topups.sort()).toEqual(["POST /v1/credits/topup/100", "POST /v1/credits/topup/20", "POST /v1/credits/topup/5"]);
    const paid = Object.fromEntries(Object.entries(priced).filter(([k]) => !topups.includes(k)).map(([k, v]) => [k, v.usd]));
    expect(paid).toEqual(PRICED);
    expect(priced["GET /v1/history/funding"]!.perRows).toBe(1000);

    // the five, mounted with the real gate in front of stub handlers (the handlers have their own tests)
    // the history route keeps its own pricing hook, stubbed to one 1,000-row page (r1 F2: the gate charges its quote)
    const five: RouteSpec[] = specs.filter((s) => s.auth === "x402" && !s.path.startsWith("/credits/")).map((s) => ({ ...s, ...("priceRequest" in s ? { priceRequest: async () => ({ usd: "0.05", rows: 1000 }) } : {}), handler: (c) => c.json({ served: `${s.method} ${s.path}` }) }));
    expect(five.length).toBe(5);
    const rs = createResourceServer(facilitator());
    const spent: string[] = [];
    const check = apiKeyCheck({ verify: async (k) => (k === "cpst_credited" ? { id: "acct-credits", ownerWallet: null, tier: "payg" } : null) });
    const { app } = await smallApp(five, {
      verifiers: { x402: x402Verifier({ check, spend: async (_id, route) => (spent.push(route), true) }) },
      payment: guardedPayment(paymentGate(pricedRoutes(five), rs, { env: "testnet", state, syncFacilitatorOnStart: true })),
    });
    const client = new x402Client((_v, reqs) => reqs[0]!);
    client.register(NETWORKS.baseSepolia, new ExactEvmScheme(payer));
    client.setSpendControls(clientSpendControls("testnet", "1"));
    const path = (k: string) => (k.includes("history") ? `${k.split(" ")[1]}?limit=1000` : k.split(" ")[1]!);
    for (const key of Object.keys(PRICED)) {
      const method = key.split(" ")[0]!;
      const init = method === "POST" ? { method, headers: { "content-type": "application/json" }, body: "{}" } : { method };
      const r1 = await app.request(path(key), init);
      expect(r1.status, key).toBe(402);
      const required = decodePaymentRequiredHeader(r1.headers.get("PAYMENT-REQUIRED")!);
      expect(required.accepts[0]!.amount).toBe(String(Number(PRICED[key as keyof typeof PRICED]) * 1e6));
      const payload = await client.createPaymentPayload(required);
      const r2 = await app.request(path(key), { ...init, headers: { ...((init as { headers?: Record<string, string> }).headers ?? {}), "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
      expect(r2.status, key).toBe(200);
      expect(((await r2.json()) as { served: string }).served).toBe(key.replace("/v1", ""));
    }
    expect(settles).toBe(5);
    // an API key with credits pays from credits instead (no 402, no settle)
    const r = await app.request("/v1/funding/forecast", { headers: { authorization: "Bearer cpst_credited" } });
    expect(r.status).toBe(200);
    expect(spent).toEqual(["GET /funding/forecast"]);
    expect(settles).toBe(5);

    // facilitator down: priced routes 503, never served free
    const downApp = (await smallApp([...five, { method: "GET", path: "/free", auth: "public", handler: (c) => c.json({ ok: 1 }) }], { verifiers: { x402: x402Verifier(null) }, payment: guardedPayment(paymentGate(pricedRoutes(five), createResourceServer(facilitator(true)), { env: "testnet", state, syncFacilitatorOnStart: true })) })).app;
    expect((await downApp.request("/v1/funding/forecast")).status).toBe(503);
    expect((await downApp.request("/v1/free")).status).toBe(200);
  }, 60_000);
});
