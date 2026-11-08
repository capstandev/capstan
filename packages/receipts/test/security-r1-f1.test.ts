// Security review r1, review-r1:6 F1: verification fails closed. A receipt forged with a leaked key and backdated into
// a past hour that has no root on chain, served with a one-leaf proof (root = its own leaf), is never valid. A receipt
// of the current hour, whose root is not posted yet, is pending, not valid.
import { describe, expect, test } from "bun:test";
import { hourEpochOf, receiptLeaf, signReceipt, verifyFull } from "../src";
import { labelSigner, prng, randomBody } from "./helpers";

const NOW = Date.parse("2026-11-08T12:30:00.000Z");

describe("security r1 F1", () => {
  test("backdated-receipt-in-empty-hour-is-invalid", async () => {
    const leaked = labelSigner("leaked-receipt-key");
    const forged = await signReceipt({ ...randomBody(prng(5), 0), ts: "2026-11-08T07:15:00.000Z" }, leaked);
    const hour = hourEpochOf(forged.ts);
    const leaf = receiptLeaf(forged);
    const latest = hour + 4; // later hours were anchored; this one was skipped (empty) and stays zero forever
    const v = await verifyFull(forged, { proof: [], root: leaf, signers: [leaked.address], readRoot: async () => null, latestHour: async () => latest, nowMs: NOW } as Parameters<typeof verifyFull>[1]);
    expect(v.valid).toBe(false);
    // the same with no latestHour answer: the time rule alone refuses an hour that ended hours ago
    const v2 = await verifyFull(forged, { proof: [], root: leaf, signers: [leaked.address], readRoot: async () => null, nowMs: NOW } as Parameters<typeof verifyFull>[1]);
    expect(v2.valid).toBe(false);
    // and with no chain reader at all (an SDK or web build with no anchor address): unchecked, never valid
    const v3 = await verifyFull(forged, { proof: [], root: leaf, signers: [leaked.address], nowMs: NOW } as Parameters<typeof verifyFull>[1]);
    expect(v3).toMatchObject({ valid: false, status: "unchecked" });
  });

  test("current-hour-receipt-is-pending-not-valid", async () => {
    const s = labelSigner("receipt-key");
    const r = await signReceipt({ ...randomBody(prng(6), 0), ts: "2026-11-08T12:10:00.000Z" }, s);
    const v = await verifyFull(r, { proof: [], root: receiptLeaf(r), signers: [s.address], readRoot: async () => null, nowMs: NOW } as Parameters<typeof verifyFull>[1]);
    expect(v.valid).toBe(false);
    expect((v as { status?: string }).status).toBe("pending");
  });
});
