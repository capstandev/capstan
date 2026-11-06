// The relay's receipt signer: a keystore file plus a password file, or the dev signer on the local chain only.
// RECEIPT_SIGNER=none (the VPS default) never reaches here: receipts go to the receipt-sign worker instead.
import { devSigner, keystoreSigner, type ConfigFor, type ServiceSigner } from "@capstan/core";

export async function loadServiceSignerForRole(cfg: ConfigFor<"relay">): Promise<ServiceSigner> {
  if (cfg.RECEIPT_SIGNER === "none") throw new Error("RECEIPT_SIGNER is none: the relay holds no receipt key");
  if (cfg.RECEIPT_SIGNER === "dev") return devSigner(cfg.RECEIPT_CHAIN_ID, "capstan-receipt-dev");
  if (!cfg.RECEIPT_KEYSTORE_PATH || !cfg.RECEIPT_KEYSTORE_PASSWORD_FILE) throw new Error("RECEIPT_KEYSTORE_PATH and RECEIPT_KEYSTORE_PASSWORD_FILE are required");
  return keystoreSigner(cfg.RECEIPT_KEYSTORE_PATH, cfg.RECEIPT_KEYSTORE_PASSWORD_FILE, { allowedChainIds: [cfg.RECEIPT_CHAIN_ID] });
}
