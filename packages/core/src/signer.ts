// Service signer: the ONE way a service key (receipt signer, anchor poster, facilitator hot key) is loaded.
// Keys live in Web3 v3 keystore files (scrypt or pbkdf2 KDF, AES-128-CTR) under the service's own Unix user; the
// password comes from a file, never an env value. The key stays inside a closure: no property, error message or log
// line ever carries it. A cloud KMS can implement the same interface later.
// User keys never come here (spec invariant 1): this module only loads the operator's own service keys.
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { readFile } from "node:fs/promises";
import type { Hex, TypedDataPayload } from "@capstan/schema";
import { bytesToHex, keccak256, stringToBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface TxRequest {
  chainId: number;
  to: Hex;
  data?: Hex;
  value?: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface ServiceSigner {
  readonly address: Hex;
  signMessage(msg: Uint8Array | string): Promise<Hex>;
  signTypedData(td: TypedDataPayload): Promise<Hex>;
  signTransaction?(tx: TxRequest): Promise<Hex>;
}

export class SignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerError";
  }
}

function fromKeyBytes(key: Uint8Array, guard?: (chainId: number) => void): ServiceSigner {
  const account = privateKeyToAccount(bytesToHex(key));
  key.fill(0);
  const signer: ServiceSigner = {
    address: account.address,
    signMessage: (msg) => account.signMessage({ message: typeof msg === "string" ? msg : { raw: msg } }),
    signTypedData: async (td) => {
      const cid = td.domain.chainId;
      if (guard && cid !== undefined) guard(Number(cid));
      // viem infers EIP712Domain from `domain`; drop it from `types` if the caller included it
      const { EIP712Domain: _ignored, ...types } = td.types;
      const sign = account.signTypedData as (p: { domain: unknown; types: unknown; primaryType: string; message: unknown }) => Promise<Hex>;
      return sign({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
    },
    signTransaction: async (tx) => {
      guard?.(tx.chainId);
      return account.signTransaction({ type: "eip1559", ...tx });
    },
  };
  // A signer printed or serialised shows only its address.
  Object.defineProperty(signer, "toJSON", { value: () => ({ address: account.address }), enumerable: false });
  Object.defineProperty(signer, Symbol.for("nodejs.util.inspect.custom"), { value: () => `ServiceSigner(${account.address})`, enumerable: false });
  return signer;
}

interface KeystoreV3 {
  version: 3;
  address?: string;
  crypto: {
    cipher: "aes-128-ctr";
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: "scrypt" | "pbkdf2";
    kdfparams: { dklen: number; salt: string; n?: number; r?: number; p?: number; c?: number; prf?: string };
    mac: string;
  };
}

const hexToBytes = (h: string): Uint8Array => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) throw new SignerError("keystore: malformed hex field");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

function deriveKey(ks: KeystoreV3, password: string): Uint8Array {
  const p = ks.crypto.kdfparams;
  const salt = hexToBytes(p.salt);
  const pw = stringToBytes(password);
  if (ks.crypto.kdf === "scrypt") {
    if (!p.n || !p.r || !p.p) throw new SignerError("keystore: scrypt parameters missing");
    return scrypt(pw, salt, { N: p.n, r: p.r, p: p.p, dkLen: p.dklen, maxmem: 2 ** 31 });
  }
  if (ks.crypto.kdf === "pbkdf2") {
    if (!p.c || p.prf !== "hmac-sha256") throw new SignerError("keystore: only pbkdf2 with hmac-sha256 is supported");
    return pbkdf2(sha256, pw, salt, { c: p.c, dkLen: p.dklen });
  }
  throw new SignerError("keystore: unsupported kdf");
}

async function aesCtr(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "AES-CTR" }, false, ["encrypt", "decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CTR", counter: iv as BufferSource, length: 128 }, k, data as BufferSource));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** Decrypt a v3 keystore JSON with a password. Throws SignerError with no key material on any failure. */
export async function decryptKeystore(json: string, password: string, guard?: (chainId: number) => void): Promise<ServiceSigner> {
  let ks: KeystoreV3;
  try {
    ks = JSON.parse(json) as KeystoreV3;
  } catch {
    throw new SignerError("keystore: not valid JSON");
  }
  if (ks?.version !== 3 || ks.crypto?.cipher !== "aes-128-ctr") throw new SignerError("keystore: only v3 aes-128-ctr keystores are supported");
  const dk = deriveKey(ks, password);
  const ct = hexToBytes(ks.crypto.ciphertext);
  const mac = keccak_256(new Uint8Array([...dk.slice(16, 32), ...ct]));
  if (!constantTimeEqual(mac, hexToBytes(ks.crypto.mac))) {
    dk.fill(0);
    throw new SignerError("keystore: wrong password or corrupt file (MAC mismatch)");
  }
  const key = await aesCtr(dk.slice(0, 16), hexToBytes(ks.crypto.cipherparams.iv), ct);
  dk.fill(0);
  if (key.length !== 32) throw new SignerError("keystore: decrypted key has the wrong length");
  const signer = fromKeyBytes(key, guard);
  if (ks.address && signer.address.toLowerCase().replace(/^0x/, "") !== ks.address.toLowerCase().replace(/^0x/, "")) {
    throw new SignerError("keystore: decrypted key does not match the keystore address");
  }
  return signer;
}

/** Load a service signer from a keystore file and a password file (first line, trailing newline dropped). */
export async function keystoreSigner(path: string, passwordFile: string, opts?: { allowedChainIds?: number[] }): Promise<ServiceSigner> {
  let json: string;
  let password: string;
  try {
    json = await readFile(path, "utf8");
  } catch {
    throw new SignerError("keystore: cannot read the keystore file");
  }
  try {
    password = (await readFile(passwordFile, "utf8")).split(/\r?\n/)[0] ?? "";
  } catch {
    throw new SignerError("keystore: cannot read the password file");
  }
  const allowed = opts?.allowedChainIds;
  const guard = allowed
    ? (cid: number) => {
        if (!allowed.includes(cid)) throw new SignerError(`signer: chain ${cid} is not allowed for this service`);
      }
    : undefined;
  return decryptKeystore(json, password, guard);
}

/**
 * Encrypt 32 key bytes into a v3 keystore (scrypt). Used by ops scripts that create testnet service keys on the
 * server itself, and by tests. The caller owns the bytes and should zero them after.
 */
export async function encryptKeystore(key: Uint8Array, password: string, opts?: { n?: number; r?: number; p?: number }): Promise<string> {
  if (key.length !== 32) throw new SignerError("keystore: key must be 32 bytes");
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const n = opts?.n ?? 262144;
  const r = opts?.r ?? 8;
  const p = opts?.p ?? 1;
  const dk = scrypt(stringToBytes(password), salt, { N: n, r, p, dkLen: 32, maxmem: 2 ** 31 });
  const k = await crypto.subtle.importKey("raw", dk.slice(0, 16) as BufferSource, { name: "AES-CTR" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv as BufferSource, length: 128 }, k, key as BufferSource));
  const mac = keccak_256(new Uint8Array([...dk.slice(16, 32), ...ct]));
  dk.fill(0);
  const address = privateKeyToAccount(bytesToHex(key)).address.toLowerCase().slice(2);
  const hx = (b: Uint8Array) => bytesToHex(b).slice(2);
  return JSON.stringify({
    version: 3,
    id: crypto.randomUUID(),
    address,
    crypto: { cipher: "aes-128-ctr", ciphertext: hx(ct), cipherparams: { iv: hx(iv) }, kdf: "scrypt", kdfparams: { dklen: 32, salt: hx(salt), n, r, p }, mac: hx(mac) },
  });
}

/**
 * Deterministic signer for local tests and the local anvil only. Its key is derived from a public string, so it is
 * worthless by design; it refuses any chain id other than 31337 (never mainnet or testnet).
 */
export function devSigner(chainId: number, label = "capstan-dev-signer"): ServiceSigner {
  if (chainId !== 31337) throw new SignerError(`devSigner refuses chain ${chainId}: it only runs on the local chain 31337`);
  const material = keccak256(toHex(`${label}:31337`)); // test-key (public, derived from a label)
  return fromKeyBytes(hexToBytes(material), (cid) => {
    if (cid !== 31337) throw new SignerError(`devSigner refuses chain ${cid}`);
  });
}
