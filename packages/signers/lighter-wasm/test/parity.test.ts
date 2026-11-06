// R3 to R5: parity with the native Go checker (same hash and a valid signature; Schnorr is randomized), fresh
// vectors from this wrapper, and no signature crossing between signing ids. Runs the checker in the pinned container.
import { describe, expect, test } from "bun:test";
import { createLighterSigner } from "../src/index";
import { CHAINS, dockerAvailable, randomCancel, randomOrder, rng, runParity } from "./helpers";
import { LIGHTER_VECTORS } from "./vectors/lighter";

const docker = dockerAvailable();

async function freshVectors(perChain: number) {
  const out: { chain: number; txType: number; txInfo: string; txHash: string; pubKey: string }[] = [];
  for (const chain of CHAINS) {
    const s = await createLighterSigner(chain);
    const { publicKey } = s.generateApiKey();
    const r = rng(0xc0ffee + chain);
    for (let i = 0; i < perChain; i++) {
      const nonce = 1_000 + i;
      const t = i % 2 === 0 ? await s.signCreateOrder(randomOrder(r, nonce)) : await s.signCancelOrder(randomCancel(r, nonce));
      out.push({ chain, txType: t.txType, txInfo: t.txInfo, txHash: t.txHash, pubKey: publicKey });
    }
    // one key registration per chain as well (the L2 Sig comes from the new key itself)
    const c = await s.signChangePubKey({ pubKeyHex: publicKey, nonce: 999, apiKeyIndex: 4, accountIndex: 12345, expiredAt: 1_893_456_000_000 });
    out.push({ chain, txType: 8, txInfo: c.txInfo, txHash: c.txHash, pubKey: publicKey });
    s.close();
  }
  return out;
}

describe("parity with native lighter-go", () => {
  test("research vectors are well formed", () => {
    expect(LIGHTER_VECTORS.length).toBe(300);
    for (const chain of CHAINS) expect(LIGHTER_VECTORS.filter((v) => v.chain === chain).length).toBe(100);
  });

  test.skipIf(!docker)(
    "300-vectors",
    () => {
      const s = runParity(LIGHTER_VECTORS);
      expect(s.failures).toEqual([]);
      expect(s).toMatchObject({ vectors: 300, hash_match: 300, sig_valid: 300, bad: 0 });
    },
    600_000,
  );

  test.skipIf(!docker)(
    "fresh-100-per-chain",
    async () => {
      const all = await freshVectors(100);
      const orders = all.filter((v) => v.txType !== 8);
      expect(orders.length).toBe(300);
      const s = runParity(orders);
      expect(s.failures).toEqual([]);
      expect(s).toMatchObject({ vectors: 300, hash_match: 300, sig_valid: 300, bad: 0 });
      const cpk = all.filter((v) => v.txType === 8);
      const c = runParity(cpk);
      expect(c).toMatchObject({ vectors: 3, hash_match: 3, sig_valid: 3, bad: 0 });
      expect(c.cross_accepted).toBe(0);
    },
    600_000,
  );

  test.skipIf(!docker)(
    "no-cross-chain",
    async () => {
      const research = runParity(LIGHTER_VECTORS);
      expect(research.cross_checked).toBe(600); // each vector against the two other signing ids
      expect(research.cross_accepted).toBe(0);
      const fresh = runParity((await freshVectors(20)).filter((v) => v.txType !== 8));
      expect(fresh.cross_checked).toBe(120);
      expect(fresh.cross_accepted).toBe(0);
      // a vector relabelled to another signing id fails on hash and signature
      const relabelled = LIGHTER_VECTORS.slice(0, 30).map((v) => ({ ...v, chain: v.chain === 304 ? 466324 : 304 }));
      const r = runParity(relabelled);
      expect(r.hash_match).toBe(0);
      expect(r.sig_valid).toBe(0);
    },
    600_000,
  );
});
