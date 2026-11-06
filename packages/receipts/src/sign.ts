// EIP-191 receipt signatures (spec 11): personal_sign over the 32 raw sha256 bytes of the receipt (not the hex text).
// This package never loads a key: callers pass a ReceiptSigner (the core ServiceSigner fits it structurally).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Hex, Receipt } from "@capstan/schema";
import { getAddress } from "viem";
import { hexToBytes, receiptHashBytes, toHex, unsignedBody } from "./hash";

export interface ReceiptSigner {
  readonly address: Hex;
  signMessage(msg: Uint8Array): Promise<Hex>;
}

/** An allowed receipt key, optionally limited to a validity window (key rotation, spec 14). Bounds are ISO times; `to` is exclusive. */
export interface SignerWindow {
  address: Hex;
  from?: string;
  to?: string;
}

export const SIG_ALG = "secp256k1-eip191" as const;
const N = secp256k1.Point.CURVE().n;

/** keccak256("\x19Ethereum Signed Message:\n32" || hash): the digest an EIP-191 signer signs for a 32-byte message. */
export function eip191Digest(msg32: Uint8Array): Uint8Array {
  if (msg32.length !== 32) throw new Error("eip191Digest: message must be 32 bytes");
  const prefix = new TextEncoder().encode("\x19Ethereum Signed Message:\n32");
  const buf = new Uint8Array(prefix.length + 32);
  buf.set(prefix);
  buf.set(msg32, prefix.length);
  return keccak_256(buf);
}

/**
 * noble v2 `format: "recovered"` gives 65 bytes with the recovery byte FIRST. Ethereum wants r || s || v (v = 27 + bit).
 */
export function nobleRecoveredToRsv(sig65: Uint8Array): Hex {
  if (sig65.length !== 65) throw new Error("expected a 65-byte recovered signature");
  const rec = sig65[0]!;
  if (rec > 1) throw new Error("recovery byte must be 0 or 1");
  const out = new Uint8Array(65);
  out.set(sig65.slice(1, 65), 0);
  out[64] = 27 + rec;
  return toHex(out);
}

/** Address of an uncompressed or compressed secp256k1 public key. */
export function addressOfPublicKey(pub: Uint8Array): Hex {
  const point = secp256k1.Point.fromBytes(pub);
  const raw = point.toBytes(false).slice(1);
  return getAddress(toHex(keccak_256(raw).slice(12)));
}

/** Recover the signer of an r||s||v signature over a 32-byte message (EIP-191). Null on any malformed or high-S signature. */
export function recoverEip191(msg32: Uint8Array, sig: Hex): Hex | null {
  let b: Uint8Array;
  try {
    b = hexToBytes(sig);
  } catch {
    return null;
  }
  if (b.length !== 65) return null;
  const v = b[64]!;
  const bit = v >= 27 ? v - 27 : v;
  if (bit !== 0 && bit !== 1) return null;
  try {
    const s = secp256k1.Signature.fromBytes(b.slice(0, 64), "compact");
    if (s.r === 0n || s.s === 0n || s.s > N / 2n) return null; // low-S only: no malleable twin verifies
    const pub = s.addRecoveryBit(bit).recoverPublicKey(eip191Digest(msg32));
    return addressOfPublicKey(pub.toBytes(false));
  } catch {
    return null;
  }
}

/** Sign a receipt body: EIP-191 over its 32-byte sha256. Returns the receipt with `sig` set (signer = signer.address). */
export async function signReceipt(r: Omit<Receipt, "sig">, s: ReceiptSigner): Promise<Receipt> {
  const body = unsignedBody(r);
  const value = await s.signMessage(receiptHashBytes(body));
  const signed: Receipt = { ...body, sig: { alg: SIG_ALG, signer: s.address, value } };
  // Refuse to hand out a receipt that would not verify (wrong signer wiring, hex text signed instead of bytes, ...).
  if (!verifyReceiptSig(signed, [s.address])) throw new Error("signReceipt: the signer's output does not verify over the receipt hash");
  return signed;
}

const eqAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function inWindow(w: SignerWindow, ts: string): boolean {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return false;
  if (w.from !== undefined && t < Date.parse(w.from)) return false;
  if (w.to !== undefined && t >= Date.parse(w.to)) return false;
  return true;
}

/**
 * True when `r.sig` is a valid EIP-191 signature over the receipt hash, recovers to `r.sig.signer`, and that signer is
 * in `allowedSigners` (a plain address, or a window that must contain `r.ts`).
 */
export function verifyReceiptSig(r: Receipt, allowedSigners: Array<Hex | SignerWindow>): boolean {
  const sig = r?.sig;
  if (!sig || sig.alg !== SIG_ALG || typeof sig.signer !== "string" || typeof sig.value !== "string") return false;
  const allowed = allowedSigners.some((a) => (typeof a === "string" ? eqAddr(a, sig.signer) : eqAddr(a.address, sig.signer) && inWindow(a, r.ts)));
  if (!allowed) return false;
  let hash: Uint8Array;
  try {
    hash = receiptHashBytes(unsignedBody(r));
  } catch {
    return false;
  }
  const rec = recoverEip191(hash, sig.value);
  return rec !== null && eqAddr(rec, sig.signer);
}

/**
 * A ReceiptSigner over raw secret-key bytes, built on noble (tests, the SDK and parity checks). The bytes stay in the
 * closure. Services use core's keystore ServiceSigner instead.
 */
export function nobleSigner(secret: Uint8Array): ReceiptSigner {
  const sk = Uint8Array.from(secret);
  const address = addressOfPublicKey(secp256k1.getPublicKey(sk, false));
  return {
    address,
    async signMessage(msg: Uint8Array): Promise<Hex> {
      const sig = secp256k1.sign(eip191Digest(msg), sk, { prehash: false, format: "recovered", lowS: true });
      return nobleRecoveredToRsv(sig);
    },
  };
}
