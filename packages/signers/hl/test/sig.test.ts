// R11: noble v2 recovery-first signatures, v 27/28 and unpadded r/s.
import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { addressOf, fromHex, padRs, recoverSigner, sigToHl, signDigest, toHex } from "../src";
import { HL_VECTORS } from "./vectors/hl";
import { testKeyFrom } from "./helpers";
import { keccak_256 } from "@noble/hashes/sha3.js";

describe("sig", () => {
  test("recovery-byte-first", () => {
    const key = testKeyFrom("sig");
    let sawShort = false;
    for (let i = 0; i < 64; i++) {
      const digest = keccak_256(new Uint8Array([i, 1, 2, 3]));
      const raw = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
      expect(raw.length).toBe(65);
      const hl = sigToHl(raw);
      expect([27, 28]).toContain(hl.v);
      expect(hl.v - 27).toBe(raw[0]!);
      expect(BigInt(hl.r)).toBe(BigInt(toHex(raw.slice(1, 33))));
      expect(BigInt(hl.s)).toBe(BigInt(toHex(raw.slice(33, 65))));
      expect(/^0x0/.test(hl.r) || /^0x0/.test(hl.s)).toBe(false); // SDK form: no leading zero
      if (hl.r.length < 66 || hl.s.length < 66) sawShort = true;
      // the wallet form r||s||v gives the same result
      const wallet = toHex(new Uint8Array([...raw.slice(1), raw[0]! + 27]));
      expect(sigToHl(wallet)).toEqual(hl);
      expect(recoverSigner(toHex(digest), hl)).toBe(addressOf(key));
      expect(signDigest(toHex(digest), key)).toEqual(hl);
      // padRs keeps the value and pads to 32 bytes
      const p = padRs(hl);
      expect(p.r.length).toBe(66);
      expect(p.s.length).toBe(66);
      expect(recoverSigner(toHex(digest), p)).toBe(addressOf(key));
    }
    // the SDK vector with a 63-hex-char r stays 63 chars
    const v0 = HL_VECTORS.l1[0]!.signature;
    expect(v0.r.length).toBe(65);
    expect(padRs(v0 as never).r).toBe(`0x0${v0.r.slice(2)}` as `0x${string}`);
    void sawShort;
    expect(() => sigToHl(new Uint8Array(65).fill(2))).toThrow();
    expect(() => sigToHl(fromHex("0x00"))).toThrow();
  });
});
