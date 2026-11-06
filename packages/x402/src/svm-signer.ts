// Solana facilitator sponsor key: loaded from an encrypted v3-style keystore file (scrypt + AES-128-CTR, the same
// format as the EVM service keystores) holding the 32-byte ed25519 secret, with the password from a file. The secret
// stays inside the kit key pair (non-extractable); nothing here logs or returns it.
// trackSvmBroadcast wraps a FacilitatorSvmSigner so the tx signature is reported BEFORE the tx is sent (crash-safe
// settlement_pending rows), like the EVM signer.
import { scrypt } from "@noble/hashes/scrypt.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder, getBase64Encoder, getTransactionDecoder, type KeyPairSigner } from "@solana/kit";
import type { FacilitatorSvmSigner } from "@x402/svm";
import { readFile } from "node:fs/promises";

export class SvmKeystoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvmKeystoreError";
  }
}

const hex = (h: string): Uint8Array => {
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2) throw new SvmKeystoreError("keystore: malformed hex field");
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
};

interface SvmKeystore {
  version: 3;
  kind: "solana-ed25519";
  crypto: { cipher: "aes-128-ctr"; ciphertext: string; cipherparams: { iv: string }; kdf: "scrypt"; kdfparams: { dklen: number; salt: string; n: number; r: number; p: number }; mac: string };
}

async function aesCtr(key: Uint8Array, iv: Uint8Array, data: Uint8Array, mode: "encrypt" | "decrypt"): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "AES-CTR" }, false, [mode]);
  const fn = mode === "encrypt" ? crypto.subtle.encrypt.bind(crypto.subtle) : crypto.subtle.decrypt.bind(crypto.subtle);
  return new Uint8Array(await fn({ name: "AES-CTR", counter: iv as BufferSource, length: 128 }, k, data as BufferSource));
}

/** Encrypt 32 ed25519 secret bytes (ops scripts on the server, and tests). The caller zeroes its copy. */
export async function encryptSvmKeystore(secret: Uint8Array, password: string, opts: { n?: number } = {}): Promise<string> {
  if (secret.length !== 32) throw new SvmKeystoreError("keystore: secret must be 32 bytes");
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const n = opts.n ?? 262144;
  const dk = scrypt(new TextEncoder().encode(password), salt, { N: n, r: 8, p: 1, dkLen: 32, maxmem: 2 ** 31 });
  const ct = await aesCtr(dk.slice(0, 16), iv, secret, "encrypt");
  const mac = keccak_256(new Uint8Array([...dk.slice(16, 32), ...ct]));
  dk.fill(0);
  const h = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const ks: SvmKeystore = {
    version: 3,
    kind: "solana-ed25519",
    crypto: { cipher: "aes-128-ctr", ciphertext: h(ct), cipherparams: { iv: h(iv) }, kdf: "scrypt", kdfparams: { dklen: 32, salt: h(salt), n, r: 8, p: 1 }, mac: h(mac) },
  };
  return JSON.stringify(ks);
}

export async function decryptSvmKeystore(json: string, password: string): Promise<KeyPairSigner> {
  let ks: SvmKeystore;
  try {
    ks = JSON.parse(json) as SvmKeystore;
  } catch {
    throw new SvmKeystoreError("keystore: not valid JSON");
  }
  if (ks?.version !== 3 || ks.kind !== "solana-ed25519" || ks.crypto?.cipher !== "aes-128-ctr" || ks.crypto.kdf !== "scrypt") {
    throw new SvmKeystoreError("keystore: only v3 solana-ed25519 scrypt keystores are supported");
  }
  const p = ks.crypto.kdfparams;
  const dk = scrypt(new TextEncoder().encode(password), hex(p.salt), { N: p.n, r: p.r, p: p.p, dkLen: p.dklen, maxmem: 2 ** 31 });
  const ct = hex(ks.crypto.ciphertext);
  const mac = keccak_256(new Uint8Array([...dk.slice(16, 32), ...ct]));
  const want = hex(ks.crypto.mac);
  let diff = mac.length ^ want.length;
  for (let i = 0; i < Math.min(mac.length, want.length); i++) diff |= mac[i]! ^ want[i]!;
  if (diff !== 0) {
    dk.fill(0);
    throw new SvmKeystoreError("keystore: wrong password or corrupt file (MAC mismatch)");
  }
  const secret = await aesCtr(dk.slice(0, 16), hex(ks.crypto.cipherparams.iv), ct, "decrypt");
  dk.fill(0);
  try {
    return await createKeyPairSignerFromPrivateKeyBytes(secret, false);
  } finally {
    secret.fill(0);
  }
}

export async function svmKeystoreSigner(path: string, passwordFile: string): Promise<KeyPairSigner> {
  let json: string;
  let pw: string;
  try {
    json = await readFile(path, "utf8");
  } catch {
    throw new SvmKeystoreError("keystore: cannot read the keystore file");
  }
  try {
    pw = (await readFile(passwordFile, "utf8")).split(/\r?\n/)[0] ?? "";
  } catch {
    throw new SvmKeystoreError("keystore: cannot read the password file");
  }
  return decryptSvmKeystore(json, pw);
}

/** The fee payer's (first) signature of a signed wire transaction, base58: the Solana tx id. */
export function svmTxSignature(signedTxBase64: string): string {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(signedTxBase64));
  const first = Object.values(tx.signatures)[0];
  if (!first) throw new Error("transaction has no signature");
  return getBase58Decoder().decode(first);
}

export function trackSvmBroadcast(signer: FacilitatorSvmSigner, onBroadcast: (signature: string) => Promise<void> | void): FacilitatorSvmSigner {
  return {
    ...signer,
    getAddresses: () => signer.getAddresses(),
    signTransaction: (t, f, n) => signer.signTransaction(t, f, n),
    simulateTransaction: (t, n, o) => signer.simulateTransaction(t, n, o),
    confirmTransaction: (s, n, o) => signer.confirmTransaction(s, n, o),
    sendTransaction: async (t, n) => {
      await onBroadcast(svmTxSignature(t));
      return signer.sendTransaction(t, n);
    },
  };
}
