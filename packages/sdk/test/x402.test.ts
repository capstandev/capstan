// R12: a 402 asking more than maxUsdPerCall is not paid; RHC USDG is payable only when listed.
import { describe, expect, test } from "bun:test";
import { ADDRESSES } from "@capstan/schema";
import { createClient } from "../src/client";
import { SdkError } from "../src/errors";
import { memoryKeyStore } from "../src/keys/memory";
import { payingFetch, sdkSpendControls, selectPayment, X402_NETWORKS, type PaymentRequired, type PaymentRequirements } from "../src/x402";

const usdc = (amount: string): PaymentRequirements => ({ scheme: "exact", network: X402_NETWORKS.base, amount, asset: ADDRESSES.usdcBase.address, payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } });
const usdg = (amount: string): PaymentRequirements => ({ scheme: "exact", network: X402_NETWORKS.rhc, amount, asset: ADDRESSES.usdgRhc.address.toLowerCase(), payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 60, extra: { name: "Global Dollar", version: "1", assetTransferMethod: "permit2" } });
const req = (...accepts: PaymentRequirements[]): PaymentRequired => ({ x402Version: 2, accepts });

function server(required: PaymentRequired) {
  const seen: { paid: string | null }[] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(r) {
      const sig = r.headers.get("PAYMENT-SIGNATURE");
      seen.push({ paid: sig });
      if (!sig) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") } });
      return Response.json([{ id: "hyperliquid:-:BTC" }]);
    },
  });
  return { url: `http://127.0.0.1:${srv.port}`, seen, stop: () => srv.stop(true) };
}

describe("x402", () => {
  test("cap", async () => {
    const controls = sdkSpendControls("mainnet", "0.05");
    // under the cap: the first allowed option is chosen (server order, Base USDC first)
    expect(selectPayment(req(usdc("10000"), usdg("10000")), controls, "0.05")).toEqual(usdc("10000"));
    // above the cap on every option: nothing is paid
    expect(selectPayment(req(usdc("50001"), usdg("60000")), controls, "0.05")).toBeNull();
    // an exact-cap price is paid
    expect(selectPayment(req(usdc("50000")), controls, "0.05")).toEqual(usdc("50000"));
    // RHC USDG only: paid when listed (default), refused when the list leaves it out
    expect(selectPayment(req(usdg("10000")), controls, "0.05")).toEqual(usdg("10000"));
    expect(selectPayment(req(usdg("10000")), sdkSpendControls("mainnet", "0.05", { includeRhcUsdg: false }), "0.05")).toBeNull();
    // an unlisted asset or network is never paid, whatever the price
    expect(selectPayment(req({ ...usdc("1"), asset: "0x0000000000000000000000000000000000000bad" }), controls, "0.05")).toBeNull();
    expect(selectPayment(req({ ...usdc("1"), network: "eip155:1" }), controls, "0.05")).toBeNull();
    // testnet controls list the testnet assets, never mainnet ones
    expect(selectPayment(req(usdc("1")), sdkSpendControls("testnet", "0.05"), "0.05")).toBeNull();

    // through fetch: the payer is called only when an option fits, and the retry carries PAYMENT-SIGNATURE
    const calls: PaymentRequirements[] = [];
    const payer = { createPaymentPayload: async (c: PaymentRequirements) => (calls.push(c), { x402Version: 2, accepted: c, payload: { signature: "0xsig" } }) };
    const over = server(req(usdc("200000")));
    try {
      const e = (await payingFetch(fetch, payer, controls, "0.05")(`${over.url}/v1/history/funding`).catch((x) => x)) as SdkError;
      expect(e.code).toBe("X402_REFUSED");
      expect(calls).toEqual([]);
      expect(over.seen.length).toBe(1);
    } finally {
      over.stop();
    }
    const ok = server(req(usdg("10000")));
    try {
      const c = createClient({ apiBase: ok.url, network: "mainnet", keystore: memoryKeyStore(), x402: { payer, maxUsdPerCall: "0.02" } });
      const m = await c.markets();
      expect(m).toEqual([{ id: "hyperliquid:-:BTC" }] as never);
      expect(calls).toEqual([usdg("10000")]);
      expect(ok.seen.map((x) => x.paid !== null)).toEqual([false, true]);
      expect(JSON.parse(Buffer.from(ok.seen[1]!.paid!, "base64").toString()).accepted).toEqual(usdg("10000"));
      // the same server with USDG left out of the list: refused, not paid
      const c2 = createClient({ apiBase: ok.url, network: "mainnet", keystore: memoryKeyStore(), x402: { payer, maxUsdPerCall: "0.02", controls: sdkSpendControls("mainnet", "0.02", { includeRhcUsdg: false }) } });
      expect(((await c2.markets().catch((x) => x)) as SdkError).code).toBe("X402_REFUSED");
      expect(calls.length).toBe(1);
    } finally {
      ok.stop();
    }
  });
});
