import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Receipt } from "@capstan/schema";
import { devSigner } from "@capstan/core";
import { recoverMessageAddress } from "viem";
import { eip191Digest, hexToBytes, nobleRecoveredToRsv, receiptHashBytes, signReceipt, verifyReceiptSig } from "../src";
import { labelSigner, prng, randHex, randomBody } from "./helpers";

describe("sig", () => {
  test("eip191", async () => {
    const s = labelSigner("eip191");
    const body = randomBody(prng(11));
    const r = await signReceipt(body, s);
    expect(r.sig.alg).toBe("secp256k1-eip191");
    expect(r.sig.signer).toBe(s.address);
    expect(hexToBytes(r.sig.value).length).toBe(65);
    // viem (an independent implementation) recovers the same signer over the 32 RAW bytes
    expect(await recoverMessageAddress({ message: { raw: receiptHashBytes(body) }, signature: r.sig.value })).toBe(s.address as never);
    expect(verifyReceiptSig(r, [s.address])).toBe(true);
    expect(verifyReceiptSig(r, [s.address.toLowerCase() as `0x${string}`])).toBe(true);
    // a signer not in the allowed list fails, even with a valid signature
    const other = labelSigner("other");
    expect(verifyReceiptSig(r, [other.address])).toBe(false);
    const byOther = await signReceipt(body, other);
    expect(verifyReceiptSig(byOther, [s.address])).toBe(false);
    // a signature claiming the allowed signer but made by another key fails
    expect(verifyReceiptSig({ ...byOther, sig: { ...byOther.sig, signer: s.address } }, [s.address])).toBe(false);
    // core's ServiceSigner fits the ReceiptSigner shape and produces verifying receipts
    const svc = devSigner(31337, "receipts-sig-test");
    const r2 = await signReceipt(body, svc);
    expect(verifyReceiptSig(r2, [svc.address])).toBe(true);
    // noble v2 recovered format is recovery byte first; the conversion yields r || s || v
    const sk = keccak_256(new TextEncoder().encode("capstan-receipts-test:noble")); // test-key (derived from a public label)
    const raw = secp256k1.sign(eip191Digest(receiptHashBytes(body)), sk, { prehash: false, format: "recovered" });
    expect(raw.length).toBe(65);
    const rsv = hexToBytes(nobleRecoveredToRsv(raw));
    expect(Buffer.from(rsv.slice(0, 64)).equals(Buffer.from(raw.slice(1)))).toBe(true);
    expect([27, 28]).toContain(rsv[64]!);
    // signing the hex TEXT instead of the bytes does not verify
    const wrong = await svc.signMessage(new TextEncoder().encode(Buffer.from(receiptHashBytes(body)).toString("hex")));
    expect(verifyReceiptSig({ ...r2, sig: { ...r2.sig, value: wrong } }, [svc.address])).toBe(false);
  });

  test("tamper-any-field", async () => {
    const rand = prng(2026);
    const s = labelSigner("tamper");
    let checks = 0;
    for (let i = 0; i < 200; i++) {
      const r = await signReceipt(randomBody(rand, i), s);
      expect(verifyReceiptSig(r, [s.address])).toBe(true);
      const mutants: Receipt[] = [];
      for (const k of Object.keys(r) as (keyof Receipt)[]) {
        if (k === "sig") continue;
        const v = r[k];
        let nv: unknown;
        if (v === null) nv = k === "builder" ? { address: randHex(rand, 20), feeBps: 1, rawUnit: "1" } : "x";
        else if (typeof v === "number") nv = v + 1;
        else if (typeof v === "string") nv = /^0x[0-9a-fA-F]+$/.test(v) ? `${v.slice(0, -1)}${v.endsWith("0") ? "1" : "0"}` : `${v}x`;
        else nv = null;
        mutants.push({ ...r, [k]: nv } as Receipt);
      }
      if (r.builder) {
        mutants.push({ ...r, builder: { ...r.builder, feeBps: r.builder.feeBps + 1 } });
        mutants.push({ ...r, builder: { ...r.builder, rawUnit: `${r.builder.rawUnit}0` } });
        mutants.push({ ...r, builder: { ...r.builder, address: randHex(rand, 20) } });
      }
      const flip = (h: string, at: number) => `${h.slice(0, at)}${h[at] === "a" ? "b" : "a"}${h.slice(at + 1)}` as `0x${string}`;
      mutants.push({ ...r, sig: { ...r.sig, value: flip(r.sig.value, 10) } });
      mutants.push({ ...r, sig: { ...r.sig, value: flip(r.sig.value, 100) } });
      mutants.push({ ...r, sig: { ...r.sig, signer: randHex(rand, 20) } });
      mutants.push({ ...r, sig: { ...r.sig, alg: "secp256k1-eip712" as "secp256k1-eip191" } });
      mutants.push({ ...r, extra: "field" } as Receipt);
      for (const m of mutants) {
        expect(verifyReceiptSig(m, [s.address])).toBe(false);
        checks++;
      }
    }
    expect(checks).toBeGreaterThan(200 * 22);
  });

  test("rotation-windows", async () => {
    const oldKey = labelSigner("old");
    const newKey = labelSigner("new");
    const body = { ...randomBody(prng(5)), ts: "2026-11-06T10:00:00.000Z" };
    const rOld = await signReceipt(body, oldKey);
    const rNew = await signReceipt({ ...body, ts: "2026-12-01T00:00:00.000Z" }, newKey);
    const windows = [
      { address: oldKey.address, to: "2026-11-30T00:00:00.000Z" },
      { address: newKey.address, from: "2026-11-30T00:00:00.000Z" },
    ];
    expect(verifyReceiptSig(rOld, windows)).toBe(true);
    expect(verifyReceiptSig(rNew, windows)).toBe(true);
    // the old key cannot sign receipts dated after its window
    const late = await signReceipt({ ...body, ts: "2026-12-02T00:00:00.000Z" }, oldKey);
    expect(verifyReceiptSig(late, windows)).toBe(false);
  });

  test("high-s-refused", async () => {
    const s = labelSigner("highs");
    const r = await signReceipt(randomBody(prng(9)), s);
    const b = hexToBytes(r.sig.value);
    const n = secp256k1.Point.CURVE().n;
    const sv = BigInt(`0x${Buffer.from(b.slice(32, 64)).toString("hex")}`);
    const hi = (n - sv).toString(16).padStart(64, "0");
    const v = b[64] === 27 ? 28 : 27;
    const twin = `0x${Buffer.from(b.slice(0, 32)).toString("hex")}${hi}${v.toString(16)}` as `0x${string}`;
    expect(verifyReceiptSig({ ...r, sig: { ...r.sig, value: twin } }, [s.address])).toBe(false);
  });
});
