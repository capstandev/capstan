// R5: a priced route answers 402 with a PAYMENT-REQUIRED header (base64 JSON, x402Version 2, field `amount`, not
// `maxAmountRequired`); a valid PAYMENT-SIGNATURE gets 200 with PAYMENT-RESPONSE. Also: ops stop = 503, a route with
// no rail left = 503 (never free), and a detection flip removes the eip3009 option on the next request.
import { describe, expect, test } from "bun:test";
import type { FacilitatorClient } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { Hono } from "hono";
import type { X402State } from "../src/accepts";
import { clientSpendControls } from "../src/client";
import { createResourceServer, paymentGate, PAYMENTS_PAUSED } from "../src/gate";
import { NETWORKS, railDefs } from "../src/networks";
import { labelAccount } from "./helpers/chain";

const payer = labelAccount("gate-payer");
const defs = railDefs("testnet");
const tok = (id: keyof typeof defs) => ({ asset: defs[id].asset, decimals: 6, name: defs[id].domain!.name, version: defs[id].domain!.version });

function fakeFacilitator() {
  const calls = { verify: 0, settle: 0, settled: [] as PaymentRequirements[] };
  const f: FacilitatorClient = {
    async verify(p: PaymentPayload) {
      calls.verify++;
      const auth = (p.payload as { authorization?: { from?: string } }).authorization;
      return { isValid: true, payer: auth?.from ?? payer.address };
    },
    async settle(_p: PaymentPayload, r: PaymentRequirements) {
      calls.settle++;
      calls.settled.push(r);
      return { success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: payer.address };
    },
    async getSupported() {
      return {
        kinds: [NETWORKS.baseSepolia, NETWORKS.rhcTestnet].map((network) => ({ x402Version: 2, scheme: "exact", network })),
        extensions: [],
        signers: { "eip155:*": ["0x00000000000000000000000000000000000000f1"] },
      };
    },
  };
  return { f, calls };
}

function makeApp(state: () => X402State, paused = () => false) {
  const { f, calls } = fakeFacilitator();
  const rs = createResourceServer(f);
  const app = new Hono();
  app.use(
    "*",
    paymentGate(
      { "GET /v1/funding/forecast": { usd: "0.01", description: "funding forecast" }, "GET /v1/history/:id": { usd: "0.05", perRows: 1000, description: "history rows" } },
      rs,
      { env: "testnet", state, paused, syncFacilitatorOnStart: true },
    ),
  );
  app.get("/v1/funding/forecast", (c) => c.json({ ok: true }));
  app.get("/v1/history/:id", (c) => c.json({ rows: [] }));
  app.get("/v1/markets", (c) => c.json({ free: true }));
  return { app, calls };
}

const baseState = (): X402State => ({
  usdgEip3009: { "4663": false, "46630": true },
  payTo: { evm: "0x00000000000000000000000000000000000000aa", sol: "So1PayTo1111111111111111111111111111111111" },
  tokens: { "base-usdc": tok("base-usdc"), "rhc-usdg-permit2": tok("rhc-usdg-permit2"), "rhc-usdg-eip3009": tok("rhc-usdg-eip3009") },
});

describe("payment gate", () => {
  test("402-then-200", async () => {
    const { app, calls } = makeApp(baseState);
    expect((await app.request("/v1/markets")).status).toBe(200); // free routes are untouched
    const r1 = await app.request("/v1/funding/forecast");
    expect(r1.status).toBe(402);
    const header = r1.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const raw = JSON.parse(Buffer.from(header!, "base64").toString("utf8")) as Record<string, unknown>;
    expect(raw.x402Version).toBe(2);
    const pr = decodePaymentRequiredHeader(header!);
    expect(pr.accepts.length).toBe(3);
    for (const a of pr.accepts) {
      expect(a.amount).toBe("10000");
      expect(a.maxTimeoutSeconds).toBe(60);
      expect(a).not.toHaveProperty("maxAmountRequired");
    }
    expect(pr.accepts.map((a) => [a.network, a.extra?.assetTransferMethod ?? "eip3009"])).toEqual([
      [NETWORKS.baseSepolia, "eip3009"],
      [NETWORKS.rhcTestnet, "permit2"],
      [NETWORKS.rhcTestnet, "eip3009"],
    ]);

    // pay on RHC USDG (eip3009) with a real x402 client signature
    const client = new x402Client((_v, reqs) => reqs.find((r) => r.network === NETWORKS.rhcTestnet && !r.extra?.assetTransferMethod)!);
    client.register(NETWORKS.rhcTestnet, new ExactEvmScheme(payer));
    client.setSpendControls(clientSpendControls("testnet", "0.05"));
    const payload = await client.createPaymentPayload(pr);
    expect(payload.accepted.network).toBe(NETWORKS.rhcTestnet);
    const r2 = await app.request("/v1/funding/forecast", { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ ok: true });
    const resp = decodePaymentResponseHeader(r2.headers.get("PAYMENT-RESPONSE")!);
    expect(resp.success).toBe(true);
    expect(calls.verify).toBe(1);
    expect(calls.settle).toBe(1);
    expect(calls.settled[0]!.amount).toBe("10000");

    // perRows: 2,500 rows costs 3 x $0.05
    const r3 = await app.request("/v1/history/abc?limit=2500");
    expect(r3.status).toBe(402);
    expect(decodePaymentRequiredHeader(r3.headers.get("PAYMENT-REQUIRED")!).accepts[0]!.amount).toBe("150000");
  });

  test("ops stop, empty rails and detection flips", async () => {
    let paused = true;
    let st = baseState();
    const { app } = makeApp(
      () => st,
      () => paused,
    );
    const p = await app.request("/v1/funding/forecast");
    expect(p.status).toBe(503);
    expect(await p.json()).toEqual(PAYMENTS_PAUSED);
    expect((await app.request("/v1/markets")).status).toBe(200);
    paused = false;
    const before = decodePaymentRequiredHeader((await app.request("/v1/funding/forecast")).headers.get("PAYMENT-REQUIRED")!);
    expect(before.accepts.length).toBe(3);
    // detection flips to absent: the next request no longer offers eip3009
    st = { ...st, usdgEip3009: { "4663": false, "46630": false } };
    const after = decodePaymentRequiredHeader((await app.request("/v1/funding/forecast")).headers.get("PAYMENT-REQUIRED")!);
    expect(after.accepts.map((a) => a.extra?.assetTransferMethod ?? "eip3009")).toEqual(["eip3009", "permit2"]);
    expect(after.accepts[0]!.network).toBe(NETWORKS.baseSepolia);
    // every rail dropped: 503, never served free
    st = { ...st, droppedRails: ["base-usdc", "solana-usdc", "rhc-usdg-permit2", "rhc-usdg-eip3009"] };
    expect((await app.request("/v1/funding/forecast")).status).toBe(503);
  });
});
