// R6: on an anvil fork of RHC 4663 (RHC_FORK_URL, local only), a fresh payer with a USDG balance set by storage write
// signs transferWithAuthorization; the facilitator settles; the payee balance rises by exactly the amount; replaying
// the same authorization fails; a second /settle with the same payload sends nothing. Skips without RHC_FORK_URL.
import { describe, expect, test } from "bun:test";
import { ADDRESSES, type Hex } from "@capstan/schema";
import { createPublicClient, http } from "viem";
import { SETTLE_GAS } from "../../src/accepts";
import { NETWORKS } from "../../src/networks";
import { balanceOf, setTokenBalance } from "../helpers/chain";
import { acceptsFor, forkFacilitator, freshPayer, pay, stateFor } from "./helpers";

const FORK = process.env.RHC_FORK_URL;
const USDG = ADDRESSES.usdgRhc.address as Hex;

(FORK ? describe : describe.skip)("RHC fork: USDG eip3009", () => {
  test("settle-and-replay", async () => {
    const pc = createPublicClient({ transport: http(FORK!) });
    expect(await pc.getChainId()).toBe(4663);
    const { service, signer } = await forkFacilitator(FORK!, NETWORKS.rhc, 4663, "rhc-eip3009");
    const payer = freshPayer();
    await setTokenBalance(FORK!, USDG, payer.address, 5_000_000n);
    const state = await stateFor(FORK!, 4663, ["rhc-usdg-eip3009", "rhc-usdg-permit2"], USDG, "1");
    const req = acceptsFor({ usd: "0.01", description: "forecast" }, state, "mainnet").find((r) => r.network === NETWORKS.rhc && !r.extra.assetTransferMethod)!;
    expect(req).toMatchObject({ amount: "10000", extra: { name: "Global Dollar", version: "1" } });

    const payload = await pay(req, payer, NETWORKS.rhc);
    expect(payload.payload).toHaveProperty("authorization");
    const before = await balanceOf(FORK!, USDG, state.payTo.evm);
    const r = await service.settle({ x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    expect(r.body.errorReason).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect((await balanceOf(FORK!, USDG, state.payTo.evm)) - before).toBe(10_000n);
    expect(await balanceOf(FORK!, USDG, payer.address)).toBe(4_990_000n);

    const rc = await pc.getTransactionReceipt({ hash: r.body.transaction as Hex });
    console.log(`gas: RHC USDG transferWithAuthorization settle used ${rc.gasUsed} gas`);
    expect(rc.gasUsed).toBeLessThanOrEqual(SETTLE_GAS["rhc-usdg-eip3009"]);

    // the same payload again: the first result, no new transaction
    const again = await service.settle({ x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    expect(again.body).toMatchObject({ success: true, transaction: r.body.transaction });
    expect(signer.sentHashes.length).toBe(1);

    // the same authorization in a new payload (different key): refused, balance unchanged
    const replay = { ...payload, resource: { url: "https://api.example.test/v1/other" } };
    const rr = await service.settle({ x402Version: 2, paymentPayload: replay, paymentRequirements: req });
    expect(rr.body.success).toBe(false);
    expect((await balanceOf(FORK!, USDG, state.payTo.evm)) - before).toBe(10_000n);
  }, 120_000);
});
