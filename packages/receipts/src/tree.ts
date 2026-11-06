// Hourly sorted-pair keccak Merkle tree (spec 11). Leaves arrive in (ts, receiptId) order. A pair hashes
// keccak256(min(a, b) || max(a, b)); an odd last node is promoted unchanged to the next layer. The Solidity side
// (contracts/src/libs/SortedPairMerkle.sol) folds proofs the same way; vectors in test/vectors keep the two equal.
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Hex } from "@capstan/schema";
import { hexToBytes, toHex } from "./hash";

export interface MerkleTree {
  root: Hex;
  layers: Hex[][];
}

function norm(h: Hex): Hex {
  const b = hexToBytes(h);
  if (b.length !== 32) throw new Error("merkle node must be 32 bytes");
  return toHex(b);
}

/** keccak256 of the two nodes in ascending byte order. */
export function hashPair(a: Hex, b: Hex): Hex {
  const x = hexToBytes(a);
  const y = hexToBytes(b);
  if (x.length !== 32 || y.length !== 32) throw new Error("merkle node must be 32 bytes");
  const [lo, hi] = Buffer.compare(Buffer.from(x), Buffer.from(y)) <= 0 ? [x, y] : [y, x];
  const buf = new Uint8Array(64);
  buf.set(lo, 0);
  buf.set(hi, 32);
  return toHex(keccak_256(buf));
}

export function buildTree(leaves: Hex[]): MerkleTree {
  if (leaves.length === 0) throw new Error("buildTree: no leaves (empty hours are skipped, never anchored)");
  const layers: Hex[][] = [leaves.map(norm)];
  while (layers[layers.length - 1]!.length > 1) {
    const cur = layers[layers.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i]!, cur[i + 1]!) : cur[i]!);
    layers.push(next);
  }
  return { root: layers[layers.length - 1]![0]!, layers };
}

export function proofFor(tree: MerkleTree, index: number): Hex[] {
  const n = tree.layers[0]!.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) throw new Error(`proofFor: index ${index} out of range`);
  const proof: Hex[] = [];
  let i = index;
  for (let l = 0; l < tree.layers.length - 1; l++) {
    const layer = tree.layers[l]!;
    const sib = i ^ 1;
    if (sib < layer.length) proof.push(layer[sib]!);
    i = Math.floor(i / 2);
  }
  return proof;
}

/** Generic sorted-pair proof check. Note: like every sorted-pair tree it accepts an internal node with a shortened proof. */
export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  try {
    let h = norm(leaf);
    for (const p of proof) h = hashPair(h, p);
    return h.toLowerCase() === norm(root).toLowerCase();
  } catch {
    return false;
  }
}
