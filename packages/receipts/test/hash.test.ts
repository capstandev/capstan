import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { keccak256, stringToBytes } from "viem";
import { hexToBytes, jcs, leafOfHash, receiptHash, receiptLeaf, signReceipt, toHex } from "../src";
import { labelSigner, prng, randomBody } from "./helpers";

describe("hash", () => {
  test("sig-excluded", async () => {
    const rand = prng(7);
    const s = labelSigner("hash");
    for (let i = 0; i < 20; i++) {
      const body = randomBody(rand, i);
      const signed = await signReceipt(body, s);
      expect(receiptHash(signed)).toBe(receiptHash(body));
      expect(receiptLeaf(signed)).toBe(receiptLeaf(body));
      // a different sig value still hashes the same
      const other = { ...signed, sig: { ...signed.sig, value: `0x${"11".repeat(65)}` as `0x${string}` } };
      expect(receiptHash(other)).toBe(receiptHash(body));
    }
  });

  test("leaf-definition", () => {
    const body = randomBody(prng(3));
    const h = sha256(new TextEncoder().encode(jcs(body)));
    expect(receiptHash(body)).toBe(toHex(h));
    expect(receiptLeaf(body)).toBe(toHex(keccak_256(h)));
    expect(receiptLeaf(body)).toBe(keccak256(hexToBytes(receiptHash(body))));
    expect(leafOfHash(receiptHash(body))).toBe(receiptLeaf(body));
    // keccak of the hex TEXT is a different value: the leaf is over bytes
    expect(receiptLeaf(body)).not.toBe(keccak256(stringToBytes(receiptHash(body))));
  });
});
