// R8: Base USDC eip3009 settles on an anvil fork of 8453 (this test starts its own fork from BASE_RPC_URL on lane
// port 21847), with the EIP-712 domain "USD Coin" v2 read from the token. On Base Sepolia the name is "USDC": both
// names are read live (read-only) and a signature made with the other net's name is refused.
// Skips without BASE_RPC_URL (and without Foundry).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ADDRESSES, type Hex } from "@capstan/schema";
import { createPublicClient, http } from "viem";
import { SETTLE_GAS } from "../../src/accepts";
import { NETWORKS } from "../../src/networks";
import { readTokenInfo } from "../../src/tokens";
import { balanceOf, haveFoundry, setTokenBalance, startAnvil, type Anvil } from "../helpers/chain";
import { acceptsFor, forkFacilitator, freshPayer, pay, stateFor } from "./helpers";

const BASE = process.env.BASE_RPC_URL;
const BASE_SEPOLIA = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const USDC = ADDRESSES.usdcBase.address as Hex;

(BASE && haveFoundry ? describe : describe.skip)("Base fork: USDC eip3009", () => {
  let fork: Anvil;
  beforeAll(async () => {
    fork = await startAnvil({ forkUrl: BASE! });
  }, 60_000);
  afterAll(async () => {
    await fork?.stop();
  });

  test("settle-and-domain-name", async () => {
    // the per-net name is read, not assumed
    const main = await readTokenInfo(createPublicClient({ transport: http(fork.url) }), USDC, 8453);
    const sep = await readTokenInfo(createPublicClient({ transport: http(BASE_SEPOLIA) }), ADDRESSES.usdcBaseSepolia.address as Hex, 84532);
    expect([main.name, main.version, main.decimals]).toEqual(["USD Coin", "2", 6]);
    expect([sep.name, sep.version, sep.decimals]).toEqual(["USDC", "2", 6]);
    const tnState = { usdgEip3009: { "4663": false, "46630": false }, payTo: { evm: "0x00000000000000000000000000000000000000aa" as Hex, sol: "x".repeat(32) }, tokens: { "base-usdc": sep } };
    expect(acceptsFor({ usd: "0.01", description: "f" }, tnState, "testnet")[0]!.extra).toEqual({ name: "USDC", version: "2" });

    const { service, signer } = await forkFacilitator(fork.url, NETWORKS.base, 8453, "base");
    const payer = freshPayer();
    await setTokenBalance(fork.url, USDC, payer.address, 3_000_000n);
    const state = await stateFor(fork.url, 8453, ["base-usdc"], USDC);
    const req = acceptsFor({ usd: "0.01", description: "forecast" }, state, "mainnet")[0]!;
    expect(req).toMatchObject({ network: NETWORKS.base, asset: USDC, amount: "10000", extra: { name: "USD Coin", version: "2" } });

    // a signature over the Sepolia name is refused on mainnet USDC
    const wrong = { ...req, extra: { name: "USDC", version: "2" } };
    const bad = await pay(wrong, payer, NETWORKS.base);
    const v = await service.verify({ x402Version: 2, paymentPayload: { ...bad, accepted: req }, paymentRequirements: req });
    expect(v.body.isValid).toBe(false);

    const p = await pay(req, payer, NETWORKS.base);
    const before = await balanceOf(fork.url, USDC, state.payTo.evm);
    const r = await service.settle({ x402Version: 2, paymentPayload: p, paymentRequirements: req });
    expect(r.body.errorReason).toBeUndefined();
    expect(r.status).toBe(200);
    expect((await balanceOf(fork.url, USDC, state.payTo.evm)) - before).toBe(10_000n);
    const rc = await createPublicClient({ transport: http(fork.url) }).getTransactionReceipt({ hash: r.body.transaction as Hex });
    console.log(`gas: Base USDC transferWithAuthorization settle used ${rc.gasUsed} gas`);
    expect(rc.gasUsed).toBeLessThanOrEqual(SETTLE_GAS["base-usdc"]);
    expect(signer.sentHashes.length).toBe(1);
  }, 120_000);
});
