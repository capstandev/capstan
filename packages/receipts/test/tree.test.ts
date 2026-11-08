import { describe, expect, test } from "bun:test";
import type { Hex } from "@capstan/schema";
import { buildTree, hashPair, proofFor, receiptLeaf, signReceipt, verifyFull, verifyProof } from "../src";
import { labelSigner, prng, randHex, randomBody } from "./helpers";

const leavesOf = (n: number, start: number): Hex[] => {
  const rand = prng(start);
  return Array.from({ length: n }, () => randHex(rand, 32));
};

describe("tree", () => {
  test("sizes-and-proofs", () => {
    const one = leavesOf(1, 1);
    const t1 = buildTree(one);
    expect(t1.root).toBe(one[0]!);
    expect(proofFor(t1, 0)).toEqual([]);
    expect(verifyProof(one[0]!, [], t1.root)).toBe(true);

    const two = leavesOf(2, 2);
    expect(buildTree(two).root).toBe(hashPair(two[0]!, two[1]!));
    expect(hashPair(two[0]!, two[1]!)).toBe(hashPair(two[1]!, two[0]!));

    const three = leavesOf(3, 3);
    const t3 = buildTree(three);
    expect(t3.root).toBe(hashPair(hashPair(three[0]!, three[1]!), three[2]!)); // odd last node promoted
    expect(proofFor(t3, 2)).toEqual([hashPair(three[0]!, three[1]!)]);

    for (const n of [2, 3, 1000, 4097]) {
      const ls = leavesOf(n, n);
      const t = buildTree(ls);
      for (let i = 0; i < n; i++) expect(verifyProof(ls[i]!, proofFor(t, i), t.root)).toBe(true);
      // a proof for leaf i never verifies leaf j
      for (let k = 0; k < Math.min(n, 200); k++) {
        const i = (k * 7919) % n;
        const j = (i + 1 + ((k * 31) % (n - 1))) % n;
        expect(verifyProof(ls[j]!, proofFor(t, i), t.root)).toBe(false);
      }
    }
    expect(() => buildTree([])).toThrow();
    expect(() => proofFor(t3, 3)).toThrow();
  });

  test("internal-node-not-accepted-by-verifyFull", async () => {
    const s = labelSigner("tree");
    const rand = prng(44);
    const receipts = await Promise.all(Array.from({ length: 4 }, (_, i) => signReceipt(randomBody(rand, i), s)));
    const leaves = receipts.map((r) => receiptLeaf(r));
    const t = buildTree(leaves);
    const internal = t.layers[1]![0]!; // hash(leaf0, leaf1)
    const shortProof = [t.layers[1]![1]!];
    // the known weakness of the generic helper: an internal node with a shortened proof verifies
    expect(verifyProof(internal, shortProof, t.root)).toBe(true);
    // verifyFull recomputes the leaf from the receipt and never uses a caller leaf for the proof
    const res = await verifyFull(receipts[0]!, { proof: shortProof, root: t.root, signers: [s.address], claimedLeaf: internal });
    expect(res.checks.leaf).toBe(false);
    expect(res.checks.proof).toBe(false);
    expect(res.valid).toBe(false);
    const good = await verifyFull(receipts[0]!, { proof: proofFor(t, 0), root: t.root, signers: [s.address], readRoot: async () => t.root });
    expect(good.valid).toBe(true);
    // the same receipt with no chain reader is sound but not valid (security r1, review-r1:6 F1: never fail open)
    const unread = await verifyFull(receipts[0]!, { proof: proofFor(t, 0), root: t.root, signers: [s.address] });
    expect(unread).toMatchObject({ valid: false, status: "unchecked" });
  });
});
