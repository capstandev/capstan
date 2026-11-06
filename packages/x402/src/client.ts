// Client helpers for paying Capstan's priced routes. RHC USDG is not a default x402 asset, so a client must opt in
// with an allowedAssets entry; every rail carries the same per-payment cap (atomic units), so a 402 asking for more
// than the cap is never paid.
import type { SpendControls } from "@x402/core/client";
import { x402Client } from "@x402/core/client";
import type { ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { usdToAtomic } from "./accepts";
import { railDefs, type X402Env } from "./networks";

export type { SpendControls };

export function clientSpendControls(env: X402Env, maxUsd: string): SpendControls {
  const defs = railDefs(env);
  const cap = usdToAtomic(maxUsd, 6).toString(); // every accepted asset is a 6-decimal dollar token
  const assets = [defs["base-usdc"], defs["solana-usdc"], defs["rhc-usdg-permit2"]];
  return {
    maxAmountPerPayment: `$${maxUsd}`,
    allowedAssets: assets.map((d) => ({ network: d.network, asset: d.asset, maxAmountPerPayment: cap })),
  };
}

/** An x402 client that pays with an EVM signer on the given networks, with Capstan's spend controls. */
export function evmPayingClient(signer: ClientEvmSigner, env: X402Env, maxUsd: string): x402Client {
  const defs = railDefs(env);
  const client = new x402Client();
  for (const n of new Set([defs["base-usdc"].network, defs["rhc-usdg-permit2"].network])) client.register(n, new ExactEvmScheme(signer));
  client.setSpendControls(clientSpendControls(env, maxUsd));
  return client;
}

/** fetch that answers a 402 by paying (within the cap) and retrying once. */
export function payingFetch(client: x402Client, f: typeof fetch = fetch): typeof fetch {
  return wrapFetchWithPayment(f, client) as typeof fetch;
}
