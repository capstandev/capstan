// R14 (BACKLOG A5, A6): on RHC testnet 46630 and Base Sepolia 84532, both USDG paths and Base Sepolia USDC settle once
// each through the facilitator. Every sender asserts the chain id first. Skips without the testnet keystore env
// (FACILITATOR_TESTNET_KEYSTORE, FACILITATOR_TESTNET_PASSWORD_FILE, X402_TESTNET_PAYER_KEYSTORE,
// X402_TESTNET_PAYER_PASSWORD_FILE, X402_TESTNET_PAYTO) and the two RPC URLs.
import { describe, expect, test } from "bun:test";
import type { Hex } from "@capstan/schema";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, http } from "viem";
import { buildFacilitator } from "../../../../apps/facilitator/src/build";
import { memoryPaymentStore } from "../../../../apps/facilitator/src/store";
import { acceptsFor, railOf, type X402State } from "../../src/accepts";
import { NETWORKS, railDefs } from "../../src/networks";
import { readTokenInfo } from "../../src/tokens";
import { quiet } from "../fork/helpers";
import { asClientSigner, haveEvmTestnet, loadEvmTestnetSigner, TESTNET_ENV } from "./keystores";

const RHC_T = process.env.RHC_TESTNET_RPC_URL;
const BASE_S = process.env.BASE_SEPOLIA_RPC_URL;

(haveEvmTestnet && RHC_T && BASE_S ? describe : describe.skip)("testnet settlements (BACKLOG A5, A6)", () => {
  test("all-rails", async () => {
    const rhc = createPublicClient({ transport: http(RHC_T!) });
    const base = createPublicClient({ transport: http(BASE_S!) });
    expect(await rhc.getChainId()).toBe(46630);
    expect(await base.getChainId()).toBe(84532);
    const hot = await loadEvmTestnetSigner("facilitator");
    const payer = asClientSigner(await loadEvmTestnetSigner("payer"));
    const d = railDefs("testnet");
    const usdg = await readTokenInfo(rhc, d["rhc-usdg-permit2"].asset as Hex, 46630, { hardVersion: "1", expectName: "Global Dollar" });
    const usdc = await readTokenInfo(base, d["base-usdc"].asset as Hex, 84532, { expectName: "USDC" });
    const state: X402State = {
      usdgEip3009: { "4663": false, "46630": true },
      payTo: { evm: TESTNET_ENV.payTo as Hex, sol: "unused-in-this-test-unused-in-this" },
      tokens: { "base-usdc": usdc, "rhc-usdg-permit2": usdg, "rhc-usdg-eip3009": usdg },
      hotKeys: [hot.address],
    };
    const { service } = buildFacilitator({
      evm: { signer: hot, networks: [{ network: NETWORKS.rhcTestnet, rpcUrl: RHC_T! }, { network: NETWORKS.baseSepolia, rpcUrl: BASE_S! }] },
      store: memoryPaymentStore(),
      log: quiet,
      alert: () => {},
      isArmed: () => false, // testnets are never gated, mainnets stay refused
    });
    const reqs = acceptsFor({ usd: "0.01", description: "testnet proof" }, state, "testnet");
    for (const rail of ["base-usdc", "rhc-usdg-permit2", "rhc-usdg-eip3009"] as const) {
      const req = reqs.find((r) => railOf(r, "testnet") === rail)!;
      const client = new x402Client(() => req);
      client.register(req.network, new ExactEvmScheme(payer));
      client.setSpendControls(false);
      const payload = await client.createPaymentPayload({ x402Version: 2, resource: { url: "https://testnet.example/v1/proof" }, accepts: [req] });
      const r = await service.settle({ x402Version: 2, paymentPayload: payload, paymentRequirements: req });
      console.log(`testnet ${rail}: ${r.status} ${r.body.transaction}`);
      expect(r.body.success).toBe(true);
    }
  }, 300_000);
});
