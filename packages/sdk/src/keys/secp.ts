// secp256k1 delegated keys (HL agent, Aster signer): generated from crypto.getRandomValues through @noble/curves.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Hex } from "@capstan/schema";
import { fromHex, toHex } from "../bytes";

export function defaultRandom(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** A fresh secret key: noble's randomSecretKey over a 48-byte seed (hash-to-field, no modulo bias). */
export function newSecretKey(random: (n: number) => Uint8Array = defaultRandom): Uint8Array {
  const seed = random(48);
  try {
    return secp256k1.utils.randomSecretKey(seed);
  } finally {
    seed.fill(0);
  }
}

export function addressOfSecret(sk: Uint8Array): Hex {
  const pub = secp256k1.getPublicKey(sk, false);
  return toHex(keccak_256(pub.slice(1)).slice(12));
}

/** RFC 6979 deterministic, low-S; returns r || s || v with v 27 or 28. */
export function signDigestRsv(digest: Hex, sk: Uint8Array): Hex {
  const d = fromHex(digest);
  if (d.length !== 32) throw new Error("digest must be 32 bytes");
  const rec = secp256k1.sign(d, sk, { prehash: false, format: "recovered" });
  const out = new Uint8Array(65);
  out.set(rec.slice(1, 65), 0);
  out[64] = 27 + rec[0]!;
  return toHex(out);
}

/** Address that produced an r||s||v signature over a digest, or null. */
export function recoverRsv(digest: Hex, sig: Hex): Hex | null {
  try {
    const b = fromHex(sig);
    if (b.length !== 65) return null;
    const v = b[64]! >= 27 ? b[64]! - 27 : b[64]!;
    if (v !== 0 && v !== 1) return null;
    const rec = new Uint8Array(65);
    rec[0] = v;
    rec.set(b.slice(0, 64), 1);
    const pub = secp256k1.recoverPublicKey(rec, fromHex(digest), { prehash: false });
    return toHex(keccak_256(secp256k1.Point.fromBytes(pub).toBytes(false).slice(1)).slice(12));
  } catch {
    return null;
  }
}

/** EIP-191 personal_sign digest of a text message. */
export function personalDigest(text: string): Hex {
  const msg = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const buf = new Uint8Array(prefix.length + msg.length);
  buf.set(prefix);
  buf.set(msg, prefix.length);
  return toHex(keccak_256(buf));
}
