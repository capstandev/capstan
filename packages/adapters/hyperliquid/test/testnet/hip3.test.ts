// R13 (BACKLOG A2): on TESTNET, an order on test:ABC (asset 110000) is not rejected for its asset id, and a builder
// order per testnet HIP-3 dex records the gate value. Skipped unless HL_TESTNET_KEYSTORE, HL_TESTNET_PASSWORD_FILE and
// HL_TESTNET_BUILDER are set.
import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { memoryMarketDataCache } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { addressOf, hashTypedPayload, l1Digest, padRs, signDigest } from "@capstan/signer-hl";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";
import { buildOnboarding, createHip3Gate, createHlReader, HL_TESTNET, runHip3TestnetGate, submitOnboarding } from "../../src";
import { assertTestnet, loadTestnetSigner, TESTNET_INFO, testnetEnvReady } from "./signer";

const ready = testnetEnvReady() && !!process.env.HL_TESTNET_BUILDER;
const t = ready ? test : test.skip;

describe("testnet hip3 (BACKLOG A2)", () => {
  t("asset-id-and-gate", async () => {
    assertTestnet(TESTNET_INFO, HL_TESTNET.network);
    const builder = process.env.HL_TESTNET_BUILDER!.toLowerCase() as Hex;
    const http = venueHttp("hyperliquid-testnet", TESTNET_INFO, createMemoryGovernor("hl-testnet-hip3"));
    const reader = createHlReader({ ...HL_TESTNET, builderAddress: builder }, http, memoryMarketDataCache());
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
    const m = (await reader.listMarkets()).find((x) => x.venueSymbol === "test:ABC")!;
    expect(m.assetId).toBe(110000);
    // a far-from-book IOC on test:ABC: any answer except an asset-id error proves the id
    const action = { type: "order" as const, orders: [{ a: 110000, b: true, p: "1", s: "1", r: false, t: { limit: { tif: "Ioc" as const } } }], grouping: "na" as const };
    const nonce = Date.now();
    const sig = signDigest(l1Digest(action, null, nonce, "Testnet", nonce + 30_000), agentKey);
    const resp = await http.postJson<unknown>("/exchange", { action, nonce, signature: sig, vaultAddress: null, expiresAfter: nonce + 30_000 });
    expect(JSON.stringify(resp)).not.toMatch(/asset/i);
    const results = await runHip3TestnetGate(reader, http, { address: agent, owner: main.address, signL1: (d) => signDigest(d, agentKey) }, { builder, dexes: ["test"] });
    expect(typeof results.test).toBe("boolean");
    const gate = createHip3Gate({});
    gate.apply(results);
    expect(gate.builderFeeSupported("test")).toBe(results.test !== false);
  }, 120_000);
});
