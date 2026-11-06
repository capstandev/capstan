// Signature shapes. Hyperliquid posts {r, s, v} with r and s as hex WITHOUT leading-zero padding (python SDK form) and
// v 27 or 28. noble v2 'recovered' signatures are 65 bytes with the recovery byte FIRST; wallets return r||s||v.
import type { Hex } from "@capstan/schema";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { checksumAddress, fromHex, keccak, toHex } from "./bytes";
import type { HlSignature } from "./types";

const N = secp256k1.Point.CURVE().n;

function unpadded(b: Uint8Array): Hex {
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return `0x${x.toString(16)}`;
}

function hexToBig(h: string, what: string): bigint {
  if (typeof h !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(h)) throw new Error(`hl-signer: ${what} must be hex of at most 32 bytes`);
  return BigInt(h);
}

function big32(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let y = x;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(y & 0xffn);
    y >>= 8n;
  }
  return out;
}

/**
 * Convert a 65-byte signature to the venue form. A Uint8Array is read as noble v2 'recovered' (recovery byte first);
 * a hex string is read as the wallet form r||s||v (v 0, 1, 27 or 28).
 */
export function sigToHl(sig65: Uint8Array | Hex): HlSignature {
  let rec: number;
  let r: Uint8Array;
  let s: Uint8Array;
  if (typeof sig65 === "string") {
    const b = fromHex(sig65);
    if (b.length !== 65) throw new Error("hl-signer: signature must be 65 bytes");
    r = b.slice(0, 32);
    s = b.slice(32, 64);
    rec = b[64]! >= 27 ? b[64]! - 27 : b[64]!;
  } else {
    if (sig65.length !== 65) throw new Error("hl-signer: signature must be 65 bytes");
    rec = sig65[0]!;
    r = sig65.slice(1, 33);
    s = sig65.slice(33, 65);
  }
  if (rec !== 0 && rec !== 1) throw new Error(`hl-signer: recovery id must be 0 or 1, got ${rec}`);
  return { r: unpadded(r), s: unpadded(s), v: (27 + rec) as 27 | 28 };
}

/** Zero-pad r and s to 32 bytes (the form some clients send; BACKLOG A2 checks whether the venue accepts it). */
export function padRs(sig: { r: Hex; s: Hex; v: number }): { r: Hex; s: Hex; v: number } {
  return { r: toHex(big32(hexToBig(sig.r, "r"))), s: toHex(big32(hexToBig(sig.s, "s"))), v: sig.v };
}

function pubToAddress(pub: Uint8Array): Hex {
  const un = secp256k1.Point.fromBytes(pub).toBytes(false);
  return checksumAddress(toHex(keccak(un.slice(1)).slice(12)));
}

/** EIP-55 address that signed `digest`. Throws on a malformed signature. */
export function recoverSigner(digest: Hex, sig: { r: Hex; s: Hex; v: number }): Hex {
  const d = fromHex(digest);
  if (d.length !== 32) throw new Error("hl-signer: digest must be 32 bytes");
  const v = sig.v >= 27 ? sig.v - 27 : sig.v;
  if (v !== 0 && v !== 1) throw new Error(`hl-signer: v must be 27 or 28, got ${sig.v}`);
  const r = hexToBig(sig.r, "r");
  const s = hexToBig(sig.s, "s");
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new Error("hl-signer: r or s out of range");
  const rec = new Uint8Array(65);
  rec[0] = v;
  rec.set(big32(r), 1);
  rec.set(big32(s), 33);
  return pubToAddress(secp256k1.recoverPublicKey(rec, d, { prehash: false }));
}

/** Address of a secp256k1 secret key. For the SDK and tests. */
export function addressOf(secretKey: Uint8Array): Hex {
  return pubToAddress(secp256k1.getPublicKey(secretKey, false));
}

/**
 * Sign a 32-byte digest (RFC 6979 deterministic, low-S). For the client SDK and tests only: no app under apps/* may
 * import this, because no server code path ever holds a key.
 */
export function signDigest(digest: Hex, secretKey: Uint8Array): HlSignature {
  const d = fromHex(digest);
  if (d.length !== 32) throw new Error("hl-signer: digest must be 32 bytes");
  return sigToHl(secp256k1.sign(d, secretKey, { prehash: false, format: "recovered" }));
}
