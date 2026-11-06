// R13: no export accepts a user main-wallet private key; the main wallet is reached through WalletSigner only.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as sdk from "../src/index";
import { SdkError } from "../src/errors";

const SRC = join(import.meta.dir, "../src");
function files(d: string): string[] {
  return readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []));
}
const KEYISH = /private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|\bseed\b/i;

describe("surface", () => {
  test("no-main-key-import", () => {
    // no exported name is about raw keys, and no exported function takes a key-named parameter
    for (const [name, v] of Object.entries(sdk)) {
      expect(KEYISH.test(name)).toBe(false);
      if (typeof v === "function") expect(KEYISH.test(String(v).split("{")[0] ?? "")).toBe(false);
    }
    // the internal key helpers are not part of the package surface
    for (const n of ["newSecretKey", "signDigestRsv", "addressOfSecret", "vaultKeyStore", "aesGcmSealer"]) expect(n in sdk).toBe(false);
    // no option, field or parameter in the source names a main-wallet key, and no key-import helper is used
    for (const f of files(SRC)) {
      const t = readFileSync(f, "utf8");
      expect({ f, m: /^\s*(privateKey|mnemonic|seedPhrase|mainWalletKey|secretKey)\??\s*:/m.test(t) }).toEqual({ f, m: false });
      expect({ f, m: /privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|fromMnemonic/.test(t) }).toEqual({ f, m: false });
    }
    // createClient refuses key-shaped options and wallets
    const base = { apiBase: "http://127.0.0.1:9", network: "mainnet" as const, keystore: sdk.memoryKeyStore() };
    for (const extra of [{ privateKey: "0x01" }, { mnemonic: "test test" }, { seed: "x" }, { walletSigner: "0xabc" }, { walletSigner: { address: async () => "0x", signTypedData: async () => "0x", signMessage: async () => "0x", privateKey: "0x01" } }]) {
      const e = (() => {
        try {
          sdk.createClient({ ...base, ...(extra as object) } as never);
          return null;
        } catch (x) {
          return x as SdkError;
        }
      })();
      expect(e?.code).toBe("INVALID_INPUT");
    }
    // the two wallet adapters take a provider or an account object, never a key
    expect(sdk.eip1193Wallet.length).toBeGreaterThanOrEqual(1);
    const w = sdk.eip1193Wallet({ request: async () => ["0x0000000000000000000000000000000000000001"] });
    expect(Object.keys(w).sort()).toEqual(["address", "signMessage", "signTypedData"]);
  });
});
