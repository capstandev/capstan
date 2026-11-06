import { describe, expect, test } from "bun:test";
import type { Hex } from "@capstan/schema";
import { buildTree, proofFor, verifyProof } from "../src";
import { prng, randHex } from "./helpers";

const flipBit = (h: Hex, rand: () => number): Hex => {
  const b = Buffer.from(h.slice(2), "hex");
  const bit = Math.floor(rand() * 256);
  b[bit >> 3] = b[bit >> 3]! ^ (1 << (bit & 7));
  return `0x${b.toString("hex")}` as Hex;
};

describe("tree fuzz", () => {
  test(
    "roundtrip",
    () => {
      const rand = prng(0xc0ffee);
      let proofs = 0;
      for (let t = 0; t < 2000; t++) {
        const n = 1 + Math.floor(rand() * 300);
        const leaves = Array.from({ length: n }, () => randHex(rand, 32));
        const tree = buildTree(leaves);
        for (let i = 0; i < n; i++) {
          const p = proofFor(tree, i);
          expect(verifyProof(leaves[i]!, p, tree.root)).toBe(true);
          proofs++;
          // a flipped bit in the leaf, one proof element or the root never verifies (rotate which one per index)
          const which = (i + t) % 3;
          if (which === 0) expect(verifyProof(flipBit(leaves[i]!, rand), p, tree.root)).toBe(false);
          else if (which === 1 && p.length > 0) {
            const k = Math.floor(rand() * p.length);
            const q = p.slice();
            q[k] = flipBit(q[k]!, rand);
            expect(verifyProof(leaves[i]!, q, tree.root)).toBe(false);
          } else expect(verifyProof(leaves[i]!, p, flipBit(tree.root, rand))).toBe(false);
        }
      }
      expect(proofs).toBeGreaterThan(250_000);
    },
    { timeout: 300_000 },
  );
});
