// R14 (BACKLOG A2): onboard, build a BTC IOC with f=20, sign locally, submit to TESTNET and see builderFee > 0 in
// userFills; a tampered f fails verifySigned; the same envelope twice is a DUPLICATE_PAYLOAD (in-memory dedupe, the
// relay's own store lands in todo 30). Skipped unless HL_TESTNET_KEYSTORE, HL_TESTNET_PASSWORD_FILE and
// HL_TESTNET_BUILDER are set.
import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { memoryMarketDataCache } from "@capstan/core";
import type { Hex, SignedEnvelope } from "@capstan/schema";
import { addressOf, hashTypedPayload, padRs, phantomSource, postBody, signDigest } from "@capstan/signer-hl";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";
import { buildOnboarding, buildOrder, createHlReader, HL_TESTNET, NonceSource, payloadHash, submit, submitOnboarding, verifySigned } from "../../src";
import { assertTestnet, loadTestnetSigner, TESTNET_INFO, testnetEnvReady } from "./signer";

const ready = testnetEnvReady() && !!process.env.HL_TESTNET_BUILDER;
const t = ready ? test : test.skip;

describe("testnet order (BACKLOG A2)", () => {
  t("fill-with-builder-fee", async () => {
    assertTestnet(TESTNET_INFO, HL_TESTNET.network);
    expect(phantomSource(HL_TESTNET.network)).toBe("b");
    const builder = process.env.HL_TESTNET_BUILDER!.toLowerCase() as Hex;
    const cfg = { ...HL_TESTNET, builderAddress: builder };
    const http = venueHttp("hyperliquid-testnet", TESTNET_INFO, createMemoryGovernor("hl-testnet-order"));
    const cache = memoryMarketDataCache();
    const reader = createHlReader(cfg, http, cache);
    const main = await loadTestnetSigner();
    const agentKey = secp256k1.utils.randomSecretKey();
    const agent = addressOf(agentKey).toLowerCase() as Hex;
    const now = Date.now();
    const bundle = await buildOnboarding(
      { venue: "hyperliquid", owner: main.address, agentAddress: agent, builderMaxBps: 3, network: "Testnet", signatureChainId: "0x66eee", agentValidUntilMs: now + 86_400_000 },
      { reader, builder, nowMs: now, declarationStep: () => ({ kind: "eligibility_declaration", signer: "main_wallet", personalSignText: "testnet proof" }) },
    );
    const signatures = bundle.steps.map((s, i) => {
      if (!s.typedData) return { step: i, sig: "0x" as Hex };
      const g = padRs(main.signDigest(hashTypedPayload(s.typedData)));
      return { step: i, sig: `0x${g.r.slice(2)}${g.s.slice(2)}${g.v.toString(16)}` as Hex };
    });
    await submitOnboarding({ bundleId: bundle.bundleId, signatures }, http, { bundle });
    await Bun.sleep(2000);
    const at = Date.now();
    const b = await buildOrder(
      { marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 100 },
      { owner: main.address, agentRef: `hl:${agent}`, identity: { venue: "hyperliquid", owner: main.address, agentAddress: agent }, builderFee: { tenthsBp: 20 }, approvedMaxBps: 3, nowMs: at, eligibilityDecisionId: "testnet", policyId: null },
      { cfg, reader, cache, nonces: new NonceSource(), enabled: () => true },
    );
    const sig = signDigest(b.digest, agentKey);
    const body = postBody(b.payload.action, sig, b.payload.nonce, undefined, b.payload.expiresAfter);
    const env: SignedEnvelope = { buildId: b.buildId, venue: "hyperliquid", encoding: "hl_l1_action", signedBody: body, signature: "0x", signerRef: agent, payloadHash: payloadHash(body) };
    expect(verifySigned(env, b)).toEqual({ ok: true });
    const tampered = structuredClone(body) as any;
    tampered.action.builder.f = 10;
    expect(verifySigned({ ...env, signedBody: tampered, payloadHash: payloadHash(tampered) }, b)).toMatchObject({ ok: false, code: "PAYLOAD_MISMATCH", field: "builder.f" });
    const seen = new Set<string>();
    const relay = async (e: SignedEnvelope) => {
      if (seen.has(e.payloadHash)) return { status: "rejected", code: "DUPLICATE_PAYLOAD" };
      seen.add(e.payloadHash);
      return submit(e, http);
    };
    const res = await relay(env);
    expect(res.status).toBe("accepted");
    expect(await relay(env)).toEqual({ status: "rejected", code: "DUPLICATE_PAYLOAD" });
    await Bun.sleep(3000);
    const fills = await reader.userFills(main.address, at - 60_000);
    expect(fills.some((f) => Number(f.builderFee ?? 0) > 0)).toBe(true);
  }, 120_000);
});
