// R11: generateApiKey returns only the public key; the private key never crosses the Worker boundary except
// through exportEncrypted, straight into the caller's wrap. R13: a missing nonce throws before reaching the WASM.
import { describe, expect, test } from "bun:test";
import { createLighterSigner } from "../src/index";
import { dockerAvailable, FIXED_EXPIRED_AT, randomOrder, rng, runParity } from "./helpers";

const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

/** Serialise a message, turning every ArrayBuffer and typed array into hex so binary secrets are visible too. */
function flatten(m: unknown): string {
  return JSON.stringify(m, (_k, v) => {
    if (v instanceof ArrayBuffer) return `bin:${v.byteLength}:${toHex(new Uint8Array(v))}`;
    if (ArrayBuffer.isView(v)) return `bin:${v.byteLength}:${toHex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}`;
    return v;
  });
}

describe("keys", () => {
  test("private-stays-inside", async () => {
    const traffic: { dir: string; text: string; op?: string }[] = [];
    let lastOp = "";
    const s = await createLighterSigner(304, {
      inspect: (dir, m) => {
        const op = (m as { op?: string }).op;
        if (op) lastOp = op;
        traffic.push({ dir, text: flatten(m), op: dir === "to-worker" ? op : `reply:${lastOp}` });
      },
    });
    const k = s.generateApiKey();
    expect(Object.keys(k)).toEqual(["publicKey"]);
    expect(k.publicKey).toMatch(/^0x[0-9a-f]{80}$/);
    const r = rng(42);
    for (let i = 0; i < 5; i++) await s.signCreateOrder(randomOrder(r, 10 + i));
    await s.signChangePubKey({ pubKeyHex: k.publicKey, nonce: 20, apiKeyIndex: 4, accountIndex: 12345 });
    await s.signApproveIntegrator({ integratorAccountIndex: 9, maxPerpsTakerFee: 0, maxPerpsMakerFee: 0, maxSpotTakerFee: 0, maxSpotMakerFee: 0, approvalExpiryMs: 0, nonce: 21, apiKeyIndex: 4, accountIndex: 12345 });
    const token = await s.createAuthToken(Math.floor(Date.now() / 1000) + 600, 4, 12345);
    expect(token.length).toBeGreaterThan(20);

    let captured = "";
    const blob = await s.exportEncrypted(async (raw) => {
      expect(raw.length).toBe(40);
      captured = toHex(raw);
      return new Uint8Array(raw.map((b) => b ^ 0x5a)); // a stand-in wrap; real callers use WebCrypto AES-GCM
    });
    expect(captured).toMatch(/^[0-9a-f]{80}$/);
    expect(captured).not.toBe(k.publicKey.slice(2));
    expect(toHex(blob)).not.toBe(captured);

    const carrying = traffic.filter((t) => t.text.includes(captured));
    expect(carrying.map((t) => t.op)).toEqual(["reply:exportRaw"]); // the one sanctioned crossing
    expect(traffic.filter((t) => /privateKey|"priv"/.test(t.text))).toEqual([]);
    s.close();
  });

  test.skipIf(!dockerAvailable())(
    "an exported key imports into a new instance and still signs for the same public key",
    async () => {
      const a = await createLighterSigner(466324);
      const { publicKey } = a.generateApiKey();
      const mask = (u: Uint8Array) => new Uint8Array(u.map((b) => b ^ 0xa5));
      const blob = await a.exportEncrypted(async (raw) => mask(raw));
      a.close();
      const b = await createLighterSigner(466324);
      await b.importEncrypted(blob, async (x) => mask(x), 12345, 4);
      const t = await b.signCreateOrder(randomOrder(rng(5), 77));
      const p = runParity([{ chain: 466324, txType: t.txType, txInfo: t.txInfo, txHash: t.txHash, pubKey: publicKey }]);
      expect(p).toMatchObject({ hash_match: 1, sig_valid: 1, bad: 0 });
      b.close();
    },
    600_000,
  );

  test("explicit-nonce", async () => {
    const posted: string[] = [];
    const s = await createLighterSigner(300, { inspect: (dir, m) => dir === "to-worker" && posted.push((m as { op: string }).op) });
    s.generateApiKey();
    const before = posted.length;
    const o = randomOrder(rng(1), 1);
    for (const bad of [undefined, -1, null, 1.5, -2, 2 ** 48]) {
      await expect(s.signCreateOrder({ ...o, nonce: bad as number })).rejects.toThrow(/nonce/);
      await expect(s.signCancelOrder({ marketIndex: 1, orderIndex: 1, nonce: bad as number, apiKeyIndex: 4, accountIndex: 12345 })).rejects.toThrow(/nonce/);
      await expect(s.signChangePubKey({ pubKeyHex: "0x" + "ab".repeat(40), nonce: bad as number, apiKeyIndex: 4, accountIndex: 12345 })).rejects.toThrow(/nonce/);
      await expect(s.signCancelAll({ timeInForce: 0, time: 0, marketIndex: 255, nonce: bad as number, apiKeyIndex: 4, accountIndex: 12345 })).rejects.toThrow(/nonce/);
      await expect(s.signApproveIntegrator({ integratorAccountIndex: 9, maxPerpsTakerFee: 0, maxPerpsMakerFee: 0, maxSpotTakerFee: 0, maxSpotMakerFee: 0, approvalExpiryMs: 0, nonce: bad as number, apiKeyIndex: 4, accountIndex: 12345 })).rejects.toThrow(/nonce/);
    }
    // none of the refused calls reached the Worker (commitKey is the only message after generateApiKey)
    expect(posted.slice(before).filter((op) => op !== "commitKey")).toEqual([]);
    // orderExpiry -1 (lighter-go turns it into now + 28 days) is refused too
    await expect(s.signCreateOrder({ ...o, orderExpiry: -1 })).rejects.toThrow(/orderExpiry/);
    // and a valid nonce goes through
    const ok = await s.signCreateOrder({ ...o, nonce: 0, expiredAt: FIXED_EXPIRED_AT });
    expect(JSON.parse(ok.txInfo).Nonce).toBe(0);
    s.close();
  });

  test("signing before a key exists is refused", async () => {
    const s = await createLighterSigner(304);
    await expect(s.signCreateOrder(randomOrder(rng(2), 1))).rejects.toThrow(/no API key/);
    await expect(s.exportEncrypted(async (r) => r)).rejects.toThrow(/no API key/);
    s.close();
  });
});
