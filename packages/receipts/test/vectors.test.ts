import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTree, proofFor, verifyProof } from "../src";
import { MERKLE_VECTORS } from "./vectors/merkle";
import { vectorSizes, writeVectors } from "./vectors/gen";

describe("vectors", () => {
  test("stable", () => {
    const dir = mkdtempSync(join(tmpdir(), "capstan-vectors-"));
    try {
      writeVectors(dir);
      for (const f of ["merkle.ts", "merkle.json"]) expect(readFileSync(join(dir, f), "utf8")).toBe(readFileSync(join(import.meta.dir, "vectors", f), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(MERKLE_VECTORS.length).toBe(20);
    expect(MERKLE_VECTORS.slice(0, 12).map((v) => v.size)).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 16, 31, 33, 100]);
    expect(MERKLE_VECTORS.map((v) => v.size)).toEqual(vectorSizes());
    for (const v of MERKLE_VECTORS) {
      expect(buildTree(v.leaves).root).toBe(v.root);
      v.leaves.forEach((l, i) => {
        expect(proofFor(buildTree(v.leaves), i)).toEqual(v.proofs[i]!);
        expect(verifyProof(l, v.proofs[i]!, v.root)).toBe(true);
      });
    }
    // every JSON line that holds a hash carries the marker the public guard looks for
    const json = readFileSync(join(import.meta.dir, "vectors", "merkle.json"), "utf8");
    for (const line of json.split("\n")) if (/0x[0-9a-f]{64}/.test(line)) expect(line).toContain('"g":"// not-a-key"');
    expect(JSON.parse(json).trees.length).toBe(20);
  });
});
