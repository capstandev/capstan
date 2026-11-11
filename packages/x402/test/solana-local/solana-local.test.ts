// Tracker line 78: the Solana x402 rail end to end on a local solana-test-validator (no faucet, no devnet, no
// mainnet write). The ledger holds the real mainnet USDC mint (read-only clone) and accounts funded at genesis. A
// paid route answers 402, the payer pays on the Solana USDC rail, the real facilitator (HTTP API on a lane port,
// SVM exact scheme, X402_SETTLE_ARMED on in this test only) verifies and settles, the balance moves once, a replay
// is refused and a wrong amount is refused.
// Skips unless solana-test-validator is on PATH (or SOLANA_TEST_VALIDATOR names it).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { Hono } from "hono";
import { createFacilitatorApp } from "../../../../apps/facilitator/src/app";
import { buildFacilitator } from "../../../../apps/facilitator/src/build";
import { settleArmed } from "../../../../apps/facilitator/src/env";
import { memoryPaymentStore } from "../../../../apps/facilitator/src/store";
import type { X402State } from "../../src/accepts";
import { createResourceServer, paymentGate } from "../../src/gate";
import { NETWORKS } from "../../src/networks";
import { quiet } from "../fork/helpers";
import { ataOf, SOLANA_LANE_PORTS, solanaValidatorBin, startLocalValidator, systemAccount, tokenAccount, tokenBalance, USDC_MINT, type LocalValidator } from "../helpers/solana-local";

const PORT = SOLANA_LANE_PORTS.facilitator;
const START_USDC = 5_000_000n; // 5 USDC

(solanaValidatorBin ? describe : describe.skip)("Solana x402 rail on a local validator (tracker 78)", () => {
  let v: LocalValidator;
  let sponsor: KeyPairSigner;
  let payer: KeyPairSigner;
  let payTo: KeyPairSigner;
  let server: ReturnType<typeof Bun.serve>;
  let armDir: string;
  const settles: { status: number; body: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    [sponsor, payer, payTo] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
    v = await startLocalValidator({
      [sponsor.address]: systemAccount(10_000_000_000), // 10 SOL at genesis: the sponsor pays fees
      [await ataOf(payer.address)]: tokenAccount(USDC_MINT, payer.address, START_USDC),
      [await ataOf(payTo.address)]: tokenAccount(USDC_MINT, payTo.address, 0n),
    });
    console.log(`local validator ${v.url} genesis ${v.genesisHash} mint ${v.mintSource} decimals ${v.decimals}`);

    // X402_SETTLE_ARMED on, in this test only: the real arming check reads a local env object, not process.env
    armDir = mkdtempSync(join(tmpdir(), "capstan-arm-"));
    writeFileSync(join(armDir, "armed"), "local proof\n");
    const armEnv = { X402_SETTLE_ARMED: "1", X402_SETTLE_ARMED_FILE: join(armDir, "armed"), CAPSTAN_NETWORK: "mainnet" };
    expect(settleArmed(armEnv)).toBe(true);
    expect(settleArmed({ ...armEnv, X402_SETTLE_ARMED: undefined })).toBe(false);

    // the local ledger stands in for mainnet: the network id is solana mainnet, the RPC is the loopback validator
    const { service } = buildFacilitator({ svm: { signer: sponsor, networks: [{ network: NETWORKS.solana, rpcUrl: v.url }] }, store: memoryPaymentStore(), log: quiet, alert: () => {}, isArmed: () => settleArmed(armEnv) });
    const app = createFacilitatorApp(service);
    server = Bun.serve({
      port: PORT,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const res = await app.fetch(req);
        if (new URL(req.url).pathname === "/settle") settles.push({ status: res.status, body: (await res.clone().json()) as Record<string, unknown> });
        return res;
      },
    });
  }, 120_000);

  afterAll(async () => {
    server?.stop(true);
    await v?.stop();
    if (armDir) rmSync(armDir, { recursive: true, force: true });
  });

  test("402, pay, verify, settle once, replay refused, wrong amount refused", async () => {
    const facilitator = new HTTPFacilitatorClient({ url: `http://127.0.0.1:${PORT}` });
    const supported = await facilitator.getSupported();
    expect(supported.kinds.map((k) => k.network)).toContain(NETWORKS.solana);
    const state: X402State = { usdgEip3009: { "4663": false, "46630": false }, payTo: { evm: "0x00000000000000000000000000000000000000aa", sol: payTo.address }, solFeePayer: sponsor.address, tokens: {} };
    const rs = createResourceServer(facilitator);
    const api = new Hono();
    let served = 0;
    api.use("*", paymentGate({ "GET /v1/funding/forecast": { usd: "0.01", description: "funding forecast" } }, rs, { env: "mainnet", state: () => state, syncFacilitatorOnStart: true }));
    api.get("/v1/funding/forecast", (c) => {
      served++;
      return c.json({ ok: true });
    });

    // 1. the paid route answers 402 with the Solana USDC rail only (no EVM token facts were given)
    const r1 = await api.request("/v1/funding/forecast");
    expect(r1.status).toBe(402);
    const pr = decodePaymentRequiredHeader(r1.headers.get("PAYMENT-REQUIRED")!);
    expect(pr.accepts.length).toBe(1);
    const req = pr.accepts[0]!;
    expect(req).toMatchObject({ scheme: "exact", network: NETWORKS.solana, asset: USDC_MINT, amount: "10000", payTo: payTo.address, extra: { feePayer: sponsor.address } });

    // 2. the payer pays: a real x402 SVM client builds and partially signs the transfer against the local RPC
    const client = new x402Client((_v, reqs) => reqs[0]!);
    client.register(NETWORKS.solana, new ExactSvmScheme(payer, { rpcUrl: v.url }));
    client.setSpendControls(false);
    const payload = await client.createPaymentPayload(pr);
    const header = encodePaymentSignatureHeader(payload);
    const payerAta = await ataOf(payer.address);
    const payToAta = await ataOf(payTo.address);
    const before = { payer: await tokenBalance(v.url, payerAta), payTo: await tokenBalance(v.url, payToAta) };
    expect(before).toEqual({ payer: START_USDC, payTo: 0n });

    // 3. verify (facilitator HTTP) is valid before anything is sent
    const ver = await facilitator.verify(payload as PaymentPayload, req as PaymentRequirements);
    expect(ver.isValid).toBe(true);

    // 3b. disarmed (the arming file removed), the same payment is refused with 403 and nothing moves
    rmSync(join(armDir, "armed"));
    const disarmed = await fetch(`http://127.0.0.1:${PORT}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: req }) });
    expect(disarmed.status).toBe(403);
    expect({ payer: await tokenBalance(v.url, payerAta), payTo: await tokenBalance(v.url, payToAta) }).toEqual(before);
    writeFileSync(join(armDir, "armed"), "local proof\n");

    // 4. the gate verifies, settles through the facilitator and serves the route
    const r2 = await api.request("/v1/funding/forecast", { headers: { "PAYMENT-SIGNATURE": header } });
    expect(r2.status).toBe(200);
    const resp = decodePaymentResponseHeader(r2.headers.get("PAYMENT-RESPONSE")!);
    expect(resp.success).toBe(true);
    expect(resp.network).toBe(NETWORKS.solana);
    expect(typeof resp.transaction).toBe("string");
    console.log(`local settle tx ${resp.transaction}`);
    expect(served).toBe(1);
    const status = await (await fetch(v.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[resp.transaction], { searchTransactionHistory: true }] }) })).json() as { result: { value: ({ err: unknown; confirmationStatus: string } | null)[] } };
    expect(status.result.value[0]?.err).toBeNull();

    // 5. the balance moved once, by exactly the price
    const after = { payer: await tokenBalance(v.url, payerAta), payTo: await tokenBalance(v.url, payToAta) };
    expect(after).toEqual({ payer: START_USDC - 10_000n, payTo: 10_000n });

    // 6. replay: the same payment header again does not move money and does not buy a second response
    const r3 = await api.request("/v1/funding/forecast", { headers: { "PAYMENT-SIGNATURE": header } });
    expect(r3.status).toBe(402);
    console.log(`replay refused at the gate: ${decodePaymentRequiredHeader(r3.headers.get("PAYMENT-REQUIRED")!).error ?? "402"}`);
    expect(served).toBe(1);
    const direct = await (await fetch(`http://127.0.0.1:${PORT}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: req }) })).json() as { success: boolean; transaction: string };
    expect(direct.transaction).toBe(resp.transaction); // idempotent: the stored settle, not a second broadcast
    expect({ payer: await tokenBalance(v.url, payerAta), payTo: await tokenBalance(v.url, payToAta) }).toEqual(after);

    // 7. wrong amount: a payment built for less than the price is refused, at verify and at settle
    const cheap = { ...req, amount: "9999" };
    const cheapPayload = await (() => {
      const c = new x402Client((_v, reqs) => reqs[0]!);
      c.register(NETWORKS.solana, new ExactSvmScheme(payer, { rpcUrl: v.url }));
      c.setSpendControls(false);
      return c.createPaymentPayload({ ...pr, accepts: [cheap] });
    })();
    // the HTTP client throws on a refused verify; the refusal body carries the reason
    const wrongVerify = await facilitator.verify({ ...cheapPayload, accepted: req } as PaymentPayload, req as PaymentRequirements).catch((e: { statusCode?: number; invalidReason?: string }) => ({ isValid: false, statusCode: e.statusCode, invalidReason: e.invalidReason }));
    expect(wrongVerify).toMatchObject({ isValid: false, statusCode: 402, invalidReason: "invalid_exact_svm_payload_amount_mismatch" });
    const r4 = await api.request("/v1/funding/forecast", { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({ ...cheapPayload, accepted: req }) } });
    expect(r4.status).toBe(402);
    const wrongSettle = await (await fetch(`http://127.0.0.1:${PORT}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, paymentPayload: { ...cheapPayload, accepted: req }, paymentRequirements: req }) })).json() as { success: boolean; errorReason?: string };
    expect(wrongSettle.success).toBe(false);
    console.log(`wrong amount refused: ${wrongVerify.invalidReason} / ${wrongSettle.errorReason}`);
    expect(served).toBe(1);
    expect({ payer: await tokenBalance(v.url, payerAta), payTo: await tokenBalance(v.url, payToAta) }).toEqual(after);

    // exactly one settle succeeded on the facilitator, and it was the one broadcast
    expect(new Set(settles.filter((s) => s.body.success === true).map((s) => s.body.transaction))).toEqual(new Set([resp.transaction]));
  }, 180_000);
});
