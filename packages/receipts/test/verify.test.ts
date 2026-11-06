import { describe, expect, test } from "bun:test";
import type { Hex } from "@capstan/schema";
import { buildTree, hourEpochOf, proofFor, receiptLeaf, signReceipt, verifyFull } from "../src";
import { labelSigner, prng, randomBody } from "./helpers";

describe("verify", () => {
  test("not-posted-is-not-invalid", async () => {
    const s = labelSigner("verify");
    const rand = prng(77);
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => signReceipt({ ...randomBody(rand, i), ts: `2026-11-06T03:0${i}:00.000Z` }, s)));
    const t = buildTree(rs.map((r) => receiptLeaf(r)));
    const proof = proofFor(t, 2);
    const hour = hourEpochOf(rs[2]!.ts);
    const asked: number[] = [];
    // hour not posted yet: not_posted, and still valid on signature + leaf + proof
    const notPosted = await verifyFull(rs[2]!, { proof, root: t.root, signers: [s.address], readRoot: async (h) => (asked.push(h), null) });
    expect(notPosted.checks).toEqual({ signature: true, leaf: true, proof: true, onChainRoot: "not_posted" });
    expect(notPosted.valid).toBe(true);
    expect(asked).toEqual([hour]);
    // a zero root from rootOf means not posted, too
    const zero = await verifyFull(rs[2]!, { proof, root: t.root, signers: [s.address], readRoot: async () => `0x${"0".repeat(64)}` as Hex });
    expect(zero.checks.onChainRoot).toBe("not_posted");
    // posted and equal
    const posted = await verifyFull(rs[2]!, { proof, root: t.root, signers: [s.address], readRoot: async () => t.root });
    expect(posted).toEqual({ valid: true, checks: { signature: true, leaf: true, proof: true, onChainRoot: true } });
    // posted and different: invalid
    const other = await verifyFull(rs[2]!, { proof, root: t.root, signers: [s.address], readRoot: async () => `0x${"12".repeat(32)}` as Hex });
    expect(other.checks.onChainRoot).toBe(false);
    expect(other.valid).toBe(false);
    // no reader: unchecked
    expect((await verifyFull(rs[2]!, { proof, root: t.root, signers: [s.address] })).checks.onChainRoot).toBe("unchecked");
    // bad signature, wrong proof, no root: each makes it invalid
    expect((await verifyFull(rs[2]!, { proof, root: t.root, signers: [labelSigner("x").address] })).valid).toBe(false);
    expect((await verifyFull(rs[2]!, { proof: proofFor(t, 1), root: t.root, signers: [s.address] })).valid).toBe(false);
    const noRoot = await verifyFull(rs[2]!, { proof: [], root: null, signers: [s.address], readRoot: async () => null });
    expect(noRoot.checks).toEqual({ signature: true, leaf: true, proof: false, onChainRoot: "not_posted" });
    expect(noRoot.valid).toBe(false);
  });

  test("hour-epoch", () => {
    expect(hourEpochOf("1970-01-01T00:59:59.999Z")).toBe(0);
    expect(hourEpochOf("1970-01-01T01:00:00.000Z")).toBe(1);
    expect(hourEpochOf("2026-11-06T03:04:05.000Z")).toBe(Math.floor(Date.UTC(2026, 10, 6, 3) / 3_600_000));
    expect(() => hourEpochOf("nope")).toThrow();
  });
});
