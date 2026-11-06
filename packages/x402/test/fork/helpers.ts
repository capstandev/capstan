// Fork test rig: a facilitator on a local anvil fork (never a public RPC), a hot key from an encrypted keystore with
// a chain allowlist, a fresh random payer (in memory only, never printed), and token balances set by storage writes.
import { decryptKeystore, encryptKeystore, logger, type ServiceSigner } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { acceptsFor, readTokenInfo, type EvmNetwork, type RailId, type X402State } from "../../src/index";
import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, http, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildFacilitator } from "../../../../apps/facilitator/src/build";
import { memoryPaymentStore } from "../../../../apps/facilitator/src/store";
import { fund } from "../helpers/chain";

export const quiet = logger("fork-test", { sink: () => {} });

/** A fork URL must be local: these tests broadcast. */
export function assertLocal(url: string): void {
  const h = new URL(url).hostname;
  if (h !== "127.0.0.1" && h !== "localhost") throw new Error(`fork tests only broadcast to a local anvil, got ${h}`);
}

export async function hotKeySigner(label: string, chainId: number): Promise<ServiceSigner> {
  const bytes = Uint8Array.from(Buffer.from(keccak256(toHex(`capstan-x402-fork-hot:${label}`)).slice(2), "hex")); // test-key (public label)
  const json = await encryptKeystore(bytes, "fork-test-password", { n: 1024 });
  bytes.fill(0);
  return decryptKeystore(json, "fork-test-password", (cid) => {
    if (cid !== chainId) throw new Error(`hot key refuses chain ${cid}`);
  });
}

/** A fresh random payer account (in memory only). */
export function freshPayer() {
  return privateKeyToAccount(generatePrivateKey());
}

export async function forkFacilitator(url: string, network: EvmNetwork, chainId: number, label: string) {
  assertLocal(url);
  const hot = await hotKeySigner(label, chainId);
  await fund(url, hot.address);
  const store = memoryPaymentStore();
  const built = buildFacilitator({
    evm: { signer: hot, networks: [{ network, rpcUrl: url }] },
    store,
    log: quiet,
    alert: () => {},
    isArmed: () => true, // a local fork of a mainnet chain id: arming is given explicitly here, never from env
    receiptTimeoutMs: 30_000,
  });
  return { ...built, store, hot, signer: built.evmSigners[network]! };
}

export async function stateFor(url: string, chainId: number, rails: RailId[], token: Hex, hard?: string, payTo?: Hex): Promise<X402State> {
  const pc = createPublicClient({ transport: http(url) });
  const info = await readTokenInfo(pc, token, chainId, hard ? { hardVersion: hard } : {});
  const tokens = Object.fromEntries(rails.map((r) => [r, info]));
  return {
    usdgEip3009: { "4663": true, "46630": true },
    eip3009MainnetEnabled: true,
    payTo: { evm: payTo ?? (privateKeyToAccount(generatePrivateKey()).address as Hex), sol: "So1PayTo1111111111111111111111111111111111" },
    tokens,
  };
}

export async function pay(req: PaymentRequirements, payer: ReturnType<typeof freshPayer>, network: EvmNetwork) {
  const client = new x402Client(() => req);
  client.register(network, new ExactEvmScheme(payer));
  client.setSpendControls(false);
  return client.createPaymentPayload({ x402Version: 2, resource: { url: "https://api.example.test/v1/funding/forecast" }, accepts: [req] });
}

export { acceptsFor };
