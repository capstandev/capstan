// Solana devnet wallets for make-wallets.sh: an encrypted solana-ed25519 v3 keystore (scrypt + AES-128-CTR, the format
// packages/x402 svmKeystoreSigner reads) per Solana role, the password in a chmod-600 file next to it. The secret is made
// here, encrypted, and zeroed; only the public address is printed and recorded.
import { decryptSvmKeystore, encryptSvmKeystore } from "@capstan/x402";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { keystorePath, passwordPath, paths, readAddresses, recordAddress, WALLETS } from "./wallets";

export async function makeSolanaWallets(env: Record<string, string | undefined> = process.env): Promise<{ role: string; address: string; created: boolean }[]> {
  const p = paths(env);
  mkdirSync(p.solana, { recursive: true, mode: 0o700 });
  const n = env.CAPSTAN_TESTNET_SCRYPT_N ? Number(env.CAPSTAN_TESTNET_SCRYPT_N) : undefined;
  const known = await readAddresses(p);
  const out: { role: string; address: string; created: boolean }[] = [];
  for (const w of WALLETS.filter((x) => x.kind === "solana")) {
    const ks = keystorePath(w, p);
    const pwf = passwordPath(w, p);
    let created = false;
    if (!existsSync(ks)) {
      if (!existsSync(pwf)) {
        writeFileSync(pwf, Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex"), { mode: 0o600 });
        chmodSync(pwf, 0o600);
      }
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const json = await encryptSvmKeystore(secret, readFileSync(pwf, "utf8").trim(), n ? { n } : {});
      secret.fill(0);
      writeFileSync(ks, json, { mode: 0o600 });
      chmodSync(ks, 0o600);
      created = true;
    } else if (!existsSync(pwf)) throw new Error(`${w.role}: keystore exists without its password file`);
    let address = known[w.role];
    if (!address || created) {
      address = (await decryptSvmKeystore(readFileSync(ks, "utf8"), readFileSync(pwf, "utf8").trim())).address;
      await recordAddress(p, w.role, address);
    }
    out.push({ role: w.role, address, created });
  }
  return out;
}

if (import.meta.main) {
  for (const r of await makeSolanaWallets()) console.log(`${r.role} ${r.address} ${r.created ? "created" : "exists"} (solana devnet)`);
}
