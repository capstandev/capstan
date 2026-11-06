// Testnet-only signer for the owner-run proofs (BACKLOG A2). Loads an encrypted Foundry/geth v3 keystore from the path
// in HL_TESTNET_KEYSTORE with the password file in HL_TESTNET_PASSWORD_FILE, signs raw EIP-712 digests, and never
// prints or returns the key. Every caller asserts the testnet host and the "Testnet" chain before signing.
import { readFileSync } from "node:fs";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Hex } from "@capstan/schema";
import { addressOf, signDigest, type HlSignature } from "@capstan/signer-hl";

export interface TestnetSigner {
  readonly address: Hex;
  signDigest(digest: Hex): HlSignature;
}

export const TESTNET_INFO = "https://api.hyperliquid-testnet.xyz";

export function testnetEnvReady(): boolean {
  return !!process.env.HL_TESTNET_KEYSTORE && !!process.env.HL_TESTNET_PASSWORD_FILE;
}

export function assertTestnet(url: string, chain: string): void {
  if (new URL(url).host !== "api.hyperliquid-testnet.xyz") throw new Error(`refusing: ${url} is not the Hyperliquid testnet host`);
  if (chain !== "Testnet") throw new Error(`refusing: hyperliquidChain ${chain} is not Testnet`);
}

export async function loadTestnetSigner(): Promise<TestnetSigner> {
  const ks = JSON.parse(readFileSync(process.env.HL_TESTNET_KEYSTORE!, "utf8")) as {
    crypto: { cipher: string; ciphertext: string; cipherparams: { iv: string }; kdf: string; kdfparams: Record<string, any>; mac: string };
  };
  const pw = utf8ToBytes(readFileSync(process.env.HL_TESTNET_PASSWORD_FILE!, "utf8").replace(/\r?\n$/, ""));
  const c = ks.crypto;
  const salt = hexToBytes(c.kdfparams.salt);
  const dk = c.kdf === "scrypt" ? scrypt(pw, salt, { N: c.kdfparams.n, r: c.kdfparams.r, p: c.kdfparams.p, dkLen: c.kdfparams.dklen }) : pbkdf2(sha256, pw, salt, { c: c.kdfparams.c, dkLen: c.kdfparams.dklen });
  const ct = hexToBytes(c.ciphertext);
  const mac = keccak_256(concatBytes(dk.slice(16, 32), ct));
  if (Buffer.from(mac).toString("hex") !== c.mac.toLowerCase()) throw new Error("keystore: wrong password");
  if (c.cipher !== "aes-128-ctr") throw new Error("keystore: unsupported cipher");
  const k = await crypto.subtle.importKey("raw", dk.slice(0, 16), "AES-CTR", false, ["decrypt"]);
  const sk = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CTR", counter: hexToBytes(c.cipherparams.iv), length: 128 }, k, ct));
  const address = addressOf(sk).toLowerCase() as Hex;
  return { address, signDigest: (d) => signDigest(d, sk) };
}
