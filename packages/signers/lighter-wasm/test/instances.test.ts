// R8: two configs in one process run in two Workers. Signing for 304 and 466324 alternately 200 times never mixes
// the chain id: every txHash equals the hash for its own id and never the other, and the ApproveIntegrator L1
// message (which reads the WASM's global chain id) always names its own id.
import { describe, expect, test } from "bun:test";
import { createLighterHasher, createLighterSigner } from "../src/index";
import { randomOrder, rng } from "./helpers";

const hex16 = (n: number) => "0x" + n.toString(16).padStart(16, "0");

describe("instances", () => {
  test("one-worker-per-config", async () => {
    const [a, b] = await Promise.all([createLighterSigner(304), createLighterSigner(466324)]);
    const [ha, hb] = await Promise.all([createLighterHasher(304), createLighterHasher(466324)]);
    a.generateApiKey();
    b.generateApiKey();
    const r = rng(77);
    for (let i = 0; i < 200; i++) {
      const s = i % 2 === 0 ? a : b;
      const own = i % 2 === 0 ? ha : hb;
      const other = i % 2 === 0 ? hb : ha;
      const o = randomOrder(r, 100 + i);
      const [t, ownHash, otherHash] = await Promise.all([s.signCreateOrder(o), own.txHashForOrder(o), other.txHashForOrder(o)]);
      expect(t.txHash).toBe(ownHash);
      expect(t.txHash).not.toBe(otherHash);
      if (i % 20 === 0) {
        const ap = await s.signApproveIntegrator({ integratorAccountIndex: 5, maxPerpsTakerFee: 0, maxPerpsMakerFee: 0, maxSpotTakerFee: 0, maxSpotMakerFee: 0, approvalExpiryMs: 0, nonce: 10_000 + i, apiKeyIndex: 4, accountIndex: 12345 });
        expect(ap.messageToSign).toContain(`chainId: ${hex16(s.chainId)}`);
      }
    }
    for (const x of [a, b, ha, hb]) x.close();
  });

  test("a closed instance refuses calls", async () => {
    const s = await createLighterSigner(304);
    s.generateApiKey();
    s.close();
    await expect(s.signCreateOrder(randomOrder(rng(1), 1))).rejects.toThrow(/closed/);
  });
});
