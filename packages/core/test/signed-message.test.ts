// R23 (SIG-1): purpose separation, replay, host and expiry checks.
import { describe, expect, test } from "bun:test";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { capstanMessage, memoryNonceStore, parseCapstanMessage, SIGNED_PURPOSES, verifyCapstanMessage, type SignedPurpose } from "../src/signed-message";

const owner = privateKeyToAccount(keccak256(toHex("capstan signed-message owner"))); // test-key
const other = privateKeyToAccount(keccak256(toHex("capstan signed-message other"))); // test-key
const HOST = "api.capstan.test";
const NOW = 1_793_900_000_000;
let n = 0;
const nonce = () => `nonce-${(n++).toString().padStart(6, "0")}`;

async function signed(purpose: SignedPurpose, o: Partial<{ host: string; issuedAt: number; expiresAt: number; body: string; nonce: string; signer: typeof owner }> = {}) {
  const text = capstanMessage({
    purpose,
    owner: owner.address,
    host: o.host ?? HOST,
    chainId: 4663,
    nonce: o.nonce ?? nonce(),
    issuedAt: o.issuedAt ?? NOW,
    expiresAt: o.expiresAt ?? NOW + 60_000,
    body: o.body,
  });
  return { text, sig: await (o.signer ?? owner).signMessage({ message: text }) };
}

const expect_ = (purpose: SignedPurpose, extra: Partial<{ host: string; nowMs: number; body: string }> = {}) => ({
  purpose,
  signers: [owner.address],
  host: extra.host ?? HOST,
  nowMs: extra.nowMs ?? NOW + 1000,
  chainId: 4663,
  ...(extra.body !== undefined ? { body: extra.body } : {}),
});

describe("signed-message", () => {
  test("format is fixed and parses back", async () => {
    const { text } = await signed("read", { body: '{"a":1}', nonce: "abcdefgh" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Capstan read");
    expect(lines[1]).toBe(`owner: ${owner.address.toLowerCase()}`);
    expect(lines.slice(2, 5)).toEqual([`host: ${HOST}`, "chain: 4663", "nonce: abcdefgh"]);
    expect(lines[7]).toMatch(/^body: [0-9a-f]{64}$/);
    expect(parseCapstanMessage(text)?.purpose).toBe("read");
    expect(parseCapstanMessage(text + "\nextra: 1")).toBeNull();
  });

  test("purpose-separated", async () => {
    // a signature for each purpose is refused by every other purpose's check
    for (const made of SIGNED_PURPOSES) {
      for (const checked of SIGNED_PURPOSES) {
        if (made === checked) continue;
        const { text, sig } = await signed(made);
        const r = await verifyCapstanMessage(text, sig, expect_(checked), memoryNonceStore());
        expect(r, `${made} used as ${checked}`).toEqual({ ok: false, reason: "purpose" });
      }
    }
    const read = await signed("read");
    expect((await verifyCapstanMessage(read.text, read.sig, expect_("read"), memoryNonceStore())).ok).toBe(true);
    for (const p of ["kill", "api_request", "ws_subscribe"] as const) {
      expect(await verifyCapstanMessage(read.text, read.sig, expect_(p), memoryNonceStore())).toEqual({ ok: false, reason: "purpose" });
      const x = await signed(p);
      expect(await verifyCapstanMessage(x.text, x.sig, expect_("read"), memoryNonceStore())).toEqual({ ok: false, reason: "purpose" });
    }
  });

  test("replayed nonce, wrong host, wrong signer, tampered text", async () => {
    const store = memoryNonceStore();
    const k = await signed("kill");
    expect((await verifyCapstanMessage(k.text, k.sig, expect_("kill"), store)).ok).toBe(true);
    expect(await verifyCapstanMessage(k.text, k.sig, expect_("kill"), store)).toEqual({ ok: false, reason: "replay" });
    const h = await signed("api_request", { host: "evil.example" });
    expect(await verifyCapstanMessage(h.text, h.sig, expect_("api_request"), store)).toEqual({ ok: false, reason: "host" });
    const o = await signed("read", { signer: other });
    expect(await verifyCapstanMessage(o.text, o.sig, expect_("read"), store)).toEqual({ ok: false, reason: "signer" });
    const t = await signed("read");
    expect(await verifyCapstanMessage(t.text.replace("chain: 4663", "chain: 46630"), t.sig, { ...expect_("read"), chainId: 46630 }, store)).toEqual({ ok: false, reason: "signer" });
    expect(await verifyCapstanMessage(t.text, "0x1234", expect_("read"), store)).toEqual({ ok: false, reason: "signature" });
  });

  test("expiry rules: 5 minutes at most, except spread_ack bound to its plan id", async () => {
    const store = memoryNonceStore();
    const long = await signed("read", { expiresAt: NOW + 5 * 60_000 + 1 });
    expect(await verifyCapstanMessage(long.text, long.sig, expect_("read"), store)).toEqual({ ok: false, reason: "expired" });
    const edge = await signed("read", { expiresAt: NOW + 5 * 60_000 });
    expect((await verifyCapstanMessage(edge.text, edge.sig, expect_("read"), store)).ok).toBe(true);
    const past = await signed("read");
    expect(await verifyCapstanMessage(past.text, past.sig, expect_("read", { nowMs: NOW + 60_000 }), store)).toEqual({ ok: false, reason: "expired" });
    const future = await signed("read", { issuedAt: NOW + 120_000, expiresAt: NOW + 180_000 });
    expect(await verifyCapstanMessage(future.text, future.sig, expect_("read"), store)).toEqual({ ok: false, reason: "expired" });
    const ack = await signed("spread_ack", { expiresAt: NOW + 60 * 60_000, body: "plan:01PLANID" });
    expect((await verifyCapstanMessage(ack.text, ack.sig, expect_("spread_ack", { body: "plan:01PLANID" }), store)).ok).toBe(true);
    const ack2 = await signed("spread_ack", { expiresAt: NOW + 60 * 60_000, body: "plan:01PLANID" });
    expect(await verifyCapstanMessage(ack2.text, ack2.sig, expect_("spread_ack", { body: "plan:OTHER" }), store)).toEqual({ ok: false, reason: "body" });
  });

  test("a rejected message does not burn its nonce", async () => {
    const store = memoryNonceStore();
    const m = await signed("read", { nonce: "keepme-01" });
    expect((await verifyCapstanMessage(m.text, m.sig, expect_("kill"), store)).ok).toBe(false);
    expect((await verifyCapstanMessage(m.text, m.sig, expect_("read"), store)).ok).toBe(true);
  });
});
