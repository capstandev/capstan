// Small byte and hex helpers shared by the signer modules. No key material passes through here.
import type { Hex } from "@capstan/schema";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex as nobleToHex, concatBytes, hexToBytes as nobleFromHex, utf8ToBytes } from "@noble/hashes/utils.js";

export { concatBytes, utf8ToBytes };

export function toHex(b: Uint8Array): Hex {
  return `0x${nobleToHex(b)}`;
}

export function fromHex(h: string): Uint8Array {
  const s = h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error(`hl-signer: not an even-length hex string: ${h.slice(0, 12)}...`);
  return nobleFromHex(s);
}

export function keccak(b: Uint8Array): Uint8Array {
  return keccak_256(b);
}

export function keccakHex(b: Uint8Array): Hex {
  return toHex(keccak_256(b));
}

/** Unsigned integer as big-endian bytes of a fixed width. Throws when it does not fit. */
export function uintBE(v: number | bigint, width: number): Uint8Array {
  let x = typeof v === "bigint" ? v : BigInt(v);
  if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error(`hl-signer: not a safe integer: ${v}`);
  if (x < 0n) throw new Error("hl-signer: negative integer");
  const out = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error(`hl-signer: integer does not fit in ${width} bytes`);
  return out;
}

export function isAddress(a: unknown): a is Hex {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
}

export function lowerAddress(a: string): Hex {
  if (!isAddress(a)) throw new Error(`hl-signer: not a 20-byte address: ${String(a).slice(0, 12)}...`);
  return a.toLowerCase() as Hex;
}

/** EIP-55 checksum form of an address. */
export function checksumAddress(a: string): Hex {
  const lower = lowerAddress(a).slice(2);
  const hash = nobleToHex(keccak_256(utf8ToBytes(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out as Hex;
}
