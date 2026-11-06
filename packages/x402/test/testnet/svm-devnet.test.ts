// R9 (devnet part, BACKLOG A5, A6): an SVM exact payment on Solana devnet settles through the facilitator. Skips
// without SOLANA_DEVNET_PAYER (+ SOLANA_DEVNET_PAYER_PASSWORD_FILE), FACILITATOR_SOL_KEYPAIR
// (+ FACILITATOR_SOL_PASSWORD_FILE) and X402_TESTNET_PAYTO_SOL. Both keys are encrypted solana-ed25519 keystores.
import { describe, expect, test } from "bun:test";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { buildFacilitator } from "../../../../apps/facilitator/src/build";
import { memoryPaymentStore } from "../../../../apps/facilitator/src/store";
import { acceptsFor } from "../../src/accepts";
import { NETWORKS } from "../../src/networks";
import { svmKeystoreSigner } from "../../src/svm-signer";
import { quiet } from "../fork/helpers";

const E = {
  payer: process.env.SOLANA_DEVNET_PAYER,
  payerPw: process.env.SOLANA_DEVNET_PAYER_PASSWORD_FILE,
  sponsor: process.env.FACILITATOR_SOL_KEYPAIR,
  sponsorPw: process.env.FACILITATOR_SOL_PASSWORD_FILE,
  payTo: process.env.X402_TESTNET_PAYTO_SOL,
};
const RPC = process.env.SOLANA_DEVNET_RPC_URL ?? "https://api.devnet.solana.com";

(Object.values(E).every(Boolean) ? describe : describe.skip)("Solana devnet settlement (BACKLOG A5, A6)", () => {
  test("devnet-settle", async () => {
    const genesis = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }) }).then((r) => r.json() as Promise<{ result: string }>);
    expect(genesis.result.startsWith(NETWORKS.solanaDevnet.slice("solana:".length))).toBe(true);
    const sponsor = await svmKeystoreSigner(E.sponsor!, E.sponsorPw!);
    const payer = await svmKeystoreSigner(E.payer!, E.payerPw!);
    const { service } = buildFacilitator({ svm: { signer: sponsor, networks: [{ network: NETWORKS.solanaDevnet, rpcUrl: RPC }] }, store: memoryPaymentStore(), log: quiet, alert: () => {}, isArmed: () => false });
    const req = acceptsFor({ usd: "0.01", description: "devnet proof" }, { usdgEip3009: { "4663": false, "46630": false }, payTo: { evm: "0x00000000000000000000000000000000000000aa", sol: E.payTo! }, solFeePayer: sponsor.address }, "testnet")[0]!;
    const client = new x402Client(() => req);
    client.register(NETWORKS.solanaDevnet, new ExactSvmScheme(payer, { rpcUrl: RPC }));
    client.setSpendControls(false);
    const payload = await client.createPaymentPayload({ x402Version: 2, resource: { url: "https://testnet.example/v1/proof" }, accepts: [req] });
    const r = await service.settle({ x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    console.log(`devnet settle: ${r.status} ${r.body.transaction}`);
    expect(r.body.success).toBe(true);
  }, 300_000);
});
