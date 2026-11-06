// Test helpers: deterministic signers from public labels (worthless keys) and random receipt bodies.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { type Hex, type Receipt, RECEIPT_ACTIONS, VENUE_IDS } from "@capstan/schema";
import { nobleSigner, type ReceiptSigner, toHex } from "../src";

/** A signer whose key is keccak256 of a public label: for tests only. */
export function labelSigner(label: string): ReceiptSigner {
  return nobleSigner(keccak_256(new TextEncoder().encode(`capstan-receipts-test:${label}`))); // test-key (derived from a public label)
}

/** Small deterministic PRNG (mulberry32). */
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

export function randHex(rand: () => number, bytes: number): Hex {
  const b = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) b[i] = Math.floor(rand() * 256);
  return toHex(b);
}

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const maybe = <T>(rand: () => number, f: () => T): T | null => (rand() < 0.5 ? null : f());

/** A random, well-formed unsigned receipt (every field populated or null at random). */
export function randomBody(rand: () => number, i = 0): Omit<Receipt, "sig"> {
  return {
    v: 1,
    receiptId: `01JTEST${String(i).padStart(19, "0")}`,
    ts: new Date(Date.UTC(2026, 10, 6, 0, 0, 0) + Math.floor(rand() * 86_400_000)).toISOString(),
    brand: "capstan",
    action: pick(rand, RECEIPT_ACTIONS),
    owner: maybe(rand, () => randHex(rand, 20)),
    agentRef: maybe(rand, () => `agent-${Math.floor(rand() * 1e6)}`),
    venue: maybe(rand, () => pick(rand, VENUE_IDS)),
    marketId: maybe(rand, () => `hyperliquid:-:BTC${Math.floor(rand() * 10)}`),
    canonicalAsset: maybe(rand, () => "BTC"),
    requestHash: randHex(rand, 32),
    buildId: maybe(rand, () => `b_${Math.floor(rand() * 1e9)}`),
    signedPayloadHash: maybe(rand, () => randHex(rand, 32)),
    builder: maybe(rand, () => ({ address: randHex(rand, 20), feeBps: Math.floor(rand() * 5), rawUnit: String(Math.floor(rand() * 100)) })),
    quoteSnapshotHash: maybe(rand, () => randHex(rand, 32)),
    eligibilityDecisionId: `el_${Math.floor(rand() * 1e9)}`,
    policyId: maybe(rand, () => `pol_${Math.floor(rand() * 1e6)}`),
    venueResponseHash: maybe(rand, () => randHex(rand, 32)),
    venueOrderId: maybe(rand, () => String(Math.floor(rand() * 1e12))),
    txHash: maybe(rand, () => randHex(rand, 32)),
    prevReceiptHash: maybe(rand, () => randHex(rand, 32)),
  };
}
