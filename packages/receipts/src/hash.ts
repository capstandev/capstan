// Receipt hash and Merkle leaf (spec 11): hash = sha256(utf8(JCS(receipt without sig))); leaf = keccak256(hash bytes).
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Hex, Receipt } from "@capstan/schema";
import { jcs } from "./jcs";

export const toHex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}` as Hex;

export function hexToBytes(h: string): Uint8Array {
  const s = h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
  if (s.length % 2 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error(`not hex: ${h.slice(0, 12)}`);
  return Uint8Array.from(Buffer.from(s, "hex"));
}

/** The receipt body that is hashed: every field except `sig` (a `sig` key on the input is dropped). */
export function unsignedBody(r: Omit<Receipt, "sig"> | Receipt): Omit<Receipt, "sig"> {
  const { sig: _sig, ...rest } = r as Receipt;
  return rest;
}

/** sha256 bytes of the canonical receipt body. */
export function receiptHashBytes(r: Omit<Receipt, "sig">): Uint8Array {
  return sha256(new TextEncoder().encode(jcs(unsignedBody(r))));
}

/** sha256(utf8(jcs(r))) as 0x hex. `sig` is never part of it. */
export function receiptHash(r: Omit<Receipt, "sig">): Hex {
  return toHex(receiptHashBytes(r));
}

/** keccak256 of the 32 sha256 bytes (not of the hex text). */
export function receiptLeaf(r: Omit<Receipt, "sig">): Hex {
  return toHex(keccak_256(receiptHashBytes(r)));
}

/** Leaf from a known receipt hash (the same input the anchor's verifyReceipt takes). */
export function leafOfHash(receiptSha256: Hex): Hex {
  const b = hexToBytes(receiptSha256);
  if (b.length !== 32) throw new Error("receipt hash must be 32 bytes");
  return toHex(keccak_256(b));
}
