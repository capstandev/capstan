// R13: clientSpendControls allows RHC USDG with a per-payment cap; a 402 asking for more than the cap is not paid.
import { describe, expect, test } from "bun:test";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { clientSpendControls, evmPayingClient, payingFetch } from "../src/client";
import { NETWORKS, railDefs } from "../src/networks";
import { labelAccount } from "./helpers/chain";

const payer = labelAccount("client-payer");

function required(amount: string): PaymentRequired {
  const d = railDefs("testnet")["rhc-usdg-permit2"];
  return {
    x402Version: 2,
    resource: { url: "https://api.example.test/v1/funding/forecast" },
    accepts: [
      { scheme: "exact", network: d.network, asset: d.asset, amount, payTo: "0x00000000000000000000000000000000000000aa", maxTimeoutSeconds: 60, extra: { name: "Global Dollar", version: "1" } },
    ],
  };
}

function fake402(amount: string) {
  const seen: { paid: boolean }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => h.set(k, v));
    const paid = h.has("PAYMENT-SIGNATURE");
    seen.push({ paid });
    if (paid) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required(amount)) } });
  }) as typeof fetch;
  return { f, seen };
}

describe("client spend controls", () => {
  test("spend-cap", async () => {
    const sc = clientSpendControls("testnet", "0.05");
    expect(sc.maxAmountPerPayment).toBe("$0.05");
    const assets = sc.allowedAssets as { network: string; asset: string; maxAmountPerPayment?: string }[];
    expect(assets).toContainEqual({ network: NETWORKS.rhcTestnet, asset: railDefs("testnet")["rhc-usdg-permit2"].asset, maxAmountPerPayment: "50000" });
    expect(assets.map((a) => a.network)).toEqual([NETWORKS.baseSepolia, NETWORKS.solanaDevnet, NETWORKS.rhcTestnet]);
    expect(clientSpendControls("mainnet", "1").allowedAssets).toContainEqual({ network: NETWORKS.rhc, asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", maxAmountPerPayment: "1000000" });

    // within the cap: paid once and retried
    const ok = fake402("10000");
    const r = await payingFetch(evmPayingClient(payer, "testnet", "0.05"), ok.f)("https://api.example.test/v1/funding/forecast");
    expect(r.status).toBe(200);
    expect(ok.seen).toEqual([{ paid: false }, { paid: true }]);

    // above the cap: never paid
    const big = fake402("50001");
    let threw = false;
    try {
      const r2 = await payingFetch(evmPayingClient(payer, "testnet", "0.05"), big.f)("https://api.example.test/v1/funding/forecast");
      expect(r2.status).toBe(402);
    } catch {
      threw = true;
    }
    expect(big.seen.every((s) => !s.paid)).toBe(true);
    expect(big.seen.length).toBe(1);
    expect(threw).toBe(true);
  });
});
