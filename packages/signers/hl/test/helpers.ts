// Test helpers: a fixed-seed PRNG and keys derived from public seed strings (never real keys).
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

/** Deterministic 32-byte test key from a public string. */
export function testKeyFrom(label: string): Uint8Array {
  return keccak_256(utf8ToBytes(`capstan-hl-signer-test:${label}`)); // test-key
}

/** mulberry32: small fixed-seed PRNG so property tests replay exactly. */
export function prng(start: number): () => number {
  let a = start >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

export function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

export function hexOf(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

import { concat, hashDomain, hashStruct, keccak256 } from "viem";

/**
 * Independent EIP-712 digest through viem's struct hasher. viem's hashTypedData refuses Hyperliquid's
 * "HyperliquidTransaction:X" type names (a colon is not a Solidity identifier), so this skips that name check only.
 */
export function viemTypedDigest(td: { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }): `0x${string}` {
  const domainTypes = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ].filter((f) => td.domain[f.name] !== undefined);
  const types = { ...td.types, EIP712Domain: domainTypes } as never;
  return keccak256(concat([`0x1901`, hashDomain({ domain: td.domain as never, types }), hashStruct({ data: td.message, primaryType: td.primaryType, types } as never)]));
}
