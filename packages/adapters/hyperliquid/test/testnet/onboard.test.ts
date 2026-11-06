// R14 (BACKLOG A2): onboard a fresh agent on Hyperliquid TESTNET with the throwaway main wallet. Skipped unless
// HL_TESTNET_KEYSTORE, HL_TESTNET_PASSWORD_FILE and HL_TESTNET_BUILDER are set. Never runs against mainnet.
import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { memoryMarketDataCache } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { addressOf, hashTypedPayload, padRs } from "@capstan/signer-hl";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";
import { buildOnboarding, createHlReader, HL_TESTNET, submitOnboarding, verifyOnboarding } from "../../src";
import { assertTestnet, loadTestnetSigner, TESTNET_INFO, testnetEnvReady } from "./signer";

const ready = testnetEnvReady() && !!process.env.HL_TESTNET_BUILDER;
const t = ready ? test : test.skip;

describe("testnet onboard (BACKLOG A2)", () => {
  t("fresh-wallet", async () => {
    assertTestnet(TESTNET_INFO, HL_TESTNET.network);
    const builder = process.env.HL_TESTNET_BUILDER!.toLowerCase() as Hex;
    const gov = createMemoryGovernor("hl-testnet-proof");
    const http = venueHttp("hyperliquid-testnet", TESTNET_INFO, gov);
    const reader = createHlReader({ ...HL_TESTNET, builderAddress: builder }, http, memoryMarketDataCache());
    const main = await loadTestnetSigner();
    const agentKey = secp256k1.utils.randomSecretKey();
    const agent = addressOf(agentKey).toLowerCase() as Hex;
    const now = Date.now();
    const bundle = await buildOnboarding(
      { venue: "hyperliquid", owner: main.address, agentAddress: agent, builderMaxBps: 3, network: "Testnet", signatureChainId: "0x66eee", agentValidUntilMs: now + 7 * 86_400_000 },
      { reader, builder, nowMs: now, declarationStep: () => ({ kind: "eligibility_declaration", signer: "main_wallet", personalSignText: "testnet proof" }) },
    );
    for (const s of bundle.steps) if (s.typedData) expect(s.typedData.message.hyperliquidChain).toBe("Testnet");
    const signatures = bundle.steps.map((s, i) => {
      if (!s.typedData) return { step: i, sig: "0x" as Hex };
      const sig = padRs(main.signDigest(hashTypedPayload(s.typedData)));
      return { step: i, sig: `0x${sig.r.slice(2)}${sig.s.slice(2)}${sig.v.toString(16)}` as Hex };
    });
    await submitOnboarding({ bundleId: bundle.bundleId, signatures }, http, { bundle });
    await Bun.sleep(2000);
    const st = await verifyOnboarding(reader, { venue: "hyperliquid", owner: main.address, agentAddress: agent }, builder);
    expect(st.agentActive).toBe(true);
    expect(await reader.maxBuilderFee(main.address, builder)).toBe(30);
  }, 60_000);
});
