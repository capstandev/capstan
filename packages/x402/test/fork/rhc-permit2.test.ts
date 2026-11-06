// R7: on the RHC fork, without a Permit2 allowance the facilitator answers 412 permit2_allowance_required; after one
// approve(Permit2) the payer signs the standard witness Witness(address to,uint256 validAfter) with spender = the x402
// Permit2 proxy, and the settle moves exactly the amount. Skips without RHC_FORK_URL.
import { describe, expect, test } from "bun:test";
import { ADDRESSES, type Hex } from "@capstan/schema";
import { createPublicClient, createWalletClient, erc20Abi, http, maxUint256 } from "viem";
import { SETTLE_GAS } from "../../src/accepts";
import { NETWORKS, PERMIT2, X402_PERMIT2_PROXY } from "../../src/networks";
import { balanceOf, fund, localChain, setTokenBalance } from "../helpers/chain";
import { acceptsFor, forkFacilitator, freshPayer, pay, stateFor } from "./helpers";

const FORK = process.env.RHC_FORK_URL;
const USDG = ADDRESSES.usdgRhc.address as Hex;

(FORK ? describe : describe.skip)("RHC fork: USDG permit2", () => {
  test("settle-and-412", async () => {
    const pc = createPublicClient({ transport: http(FORK!) });
    expect(await pc.getChainId()).toBe(4663);
    const { service, signer } = await forkFacilitator(FORK!, NETWORKS.rhc, 4663, "rhc-permit2");
    const payer = freshPayer();
    await setTokenBalance(FORK!, USDG, payer.address, 1_000_000n);
    const state = await stateFor(FORK!, 4663, ["rhc-usdg-permit2"], USDG, "1");
    const req = acceptsFor({ usd: "0.02", description: "spread scan" }, state, "mainnet").find((r) => r.extra.assetTransferMethod === "permit2")!;
    expect(req).toMatchObject({ network: NETWORKS.rhc, asset: USDG, amount: "20000" });

    // no allowance: 412
    const p1 = await pay(req, payer, NETWORKS.rhc);
    const auth = (p1.payload as { permit2Authorization: { spender: string; witness: { to: string; validAfter: string } } }).permit2Authorization;
    expect(auth.spender.toLowerCase()).toBe(X402_PERMIT2_PROXY.toLowerCase());
    expect(auth.witness.to.toLowerCase()).toBe(state.payTo.evm.toLowerCase());
    expect(Object.keys(auth.witness).sort()).toEqual(["to", "validAfter"]);
    const v = await service.verify({ x402Version: 2, paymentPayload: p1, paymentRequirements: req });
    expect(v.status).toBe(412);
    expect(v.body.invalidReason).toBe("permit2_allowance_required");
    const s = await service.settle({ x402Version: 2, paymentPayload: p1, paymentRequirements: req });
    expect(s.status).toBe(412);
    expect(s.body.errorReason).toBe("permit2_allowance_required");
    expect(signer.sentHashes.length).toBe(0);

    // one approve(Permit2), then a fresh signature settles
    await fund(FORK!, payer.address);
    const wc = createWalletClient({ account: payer, chain: localChain(4663, FORK!), transport: http(FORK!) });
    const ah = await wc.writeContract({ address: USDG, abi: erc20Abi, functionName: "approve", args: [PERMIT2, maxUint256] });
    await pc.waitForTransactionReceipt({ hash: ah });
    const p2 = await pay(req, payer, NETWORKS.rhc);
    const before = await balanceOf(FORK!, USDG, state.payTo.evm);
    const r = await service.settle({ x402Version: 2, paymentPayload: p2, paymentRequirements: req });
    expect(r.body.errorReason).toBeUndefined();
    expect(r.status).toBe(200);
    expect((await balanceOf(FORK!, USDG, state.payTo.evm)) - before).toBe(20_000n);
    const rc = await pc.getTransactionReceipt({ hash: r.body.transaction as Hex });
    console.log(`gas: RHC USDG permit2 proxy settle used ${rc.gasUsed} gas`);
    expect(rc.gasUsed).toBeLessThanOrEqual(SETTLE_GAS["rhc-usdg-permit2"]);
    // the earlier, refused payload was not left as a settled row; the new one cannot be replayed
    const again = await service.settle({ x402Version: 2, paymentPayload: { ...p2, resource: { url: "https://api.example.test/v1/x" } }, paymentRequirements: req });
    expect(again.body.success).toBe(false);
    expect(signer.sentHashes.length).toBe(1);
  }, 120_000);
});
