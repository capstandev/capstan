// Testnet keystores for R9 and R14 (BACKLOG A5, A6). Keys live in encrypted keystore files made by the owner's setup
// command; tests read the paths from env and never print or copy a key.
import { keystoreSigner, type ServiceSigner } from "@capstan/core";
import type { ClientEvmSigner } from "@x402/evm";

export const TESTNET_ENV = {
  facilitatorKeystore: process.env.FACILITATOR_TESTNET_KEYSTORE,
  facilitatorPassword: process.env.FACILITATOR_TESTNET_PASSWORD_FILE,
  payerKeystore: process.env.X402_TESTNET_PAYER_KEYSTORE,
  payerPassword: process.env.X402_TESTNET_PAYER_PASSWORD_FILE,
  payTo: process.env.X402_TESTNET_PAYTO,
};
export const haveEvmTestnet = Object.values(TESTNET_ENV).every((v) => !!v);
export const TESTNET_CHAIN_IDS = [46630, 84532];

export function loadEvmTestnetSigner(kind: "facilitator" | "payer"): Promise<ServiceSigner> {
  const [p, pw] = kind === "facilitator" ? [TESTNET_ENV.facilitatorKeystore!, TESTNET_ENV.facilitatorPassword!] : [TESTNET_ENV.payerKeystore!, TESTNET_ENV.payerPassword!];
  return keystoreSigner(p, pw, { allowedChainIds: TESTNET_CHAIN_IDS });
}

/** x402 client signer over a ServiceSigner (typed data only; it refuses non-testnet chain ids through the keystore guard). */
export function asClientSigner(s: ServiceSigner): ClientEvmSigner {
  return {
    address: s.address,
    signTypedData: (m) => s.signTypedData(m as never),
  };
}
