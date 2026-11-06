// Byte helpers. No key material is ever turned into text here: callers zero secret buffers after use.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes as nobleHexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import type { Hex } from "@capstan/schema";

export { concatBytes, utf8ToBytes };

export function toHex(b: Uint8Array): Hex {
  return `0x${bytesToHex(b)}`;
}

export function fromHex(h: string): Uint8Array {
  const s = h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error("not an even-length hex string");
  return nobleHexToBytes(s);
}

export const keccakHex = (b: Uint8Array): Hex => toHex(keccak_256(b));
export const sha256Hex = (b: Uint8Array): Hex => toHex(sha256(b));

export function jcsString(v: unknown): string {
  const s = canonicalize(v);
  if (s === undefined) throw new Error("value is not JSON");
  return s;
}

/** sha256 of the RFC 8785 JCS form (the relay's payload hash for HL bodies, the receipt request hash). */
export const sha256Jcs = (v: unknown): Hex => sha256Hex(utf8ToBytes(jcsString(v)));

export const isAddress = (a: unknown): a is Hex => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
export const eqAddr = (a: unknown, b: unknown): boolean => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export function b64encode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
