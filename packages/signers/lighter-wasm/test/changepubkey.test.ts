// R12: the ChangePubKey messageToSign matches the documented template byte for byte.
import { describe, expect, test } from "bun:test";
import { createLighterSigner } from "../src/index";

const hex16 = (n: number) => "0x" + n.toString(16).padStart(16, "0");

describe("ChangePubKey", () => {
  test("template", async () => {
    for (const chain of [304, 466324, 300] as const) {
      const s = await createLighterSigner(chain);
      const { publicKey } = s.generateApiKey();
      for (const [nonce, account, idx] of [
        [0, 1, 4],
        [17, 12345, 158],
        [1_793_815_165_948, 281474976710654, 254],
      ] as const) {
        const r = await s.signChangePubKey({ pubKeyHex: publicKey, nonce, apiKeyIndex: idx, accountIndex: account });
        const want = `Register Lighter Account\n\npubkey: 0x${publicKey.slice(2)}\nnonce: ${hex16(nonce)}\naccount index: ${hex16(account)}\napi key index: ${hex16(idx)}\nOnly sign this message for a trusted client!`;
        expect(r.messageToSign).toBe(want);
        expect(r.messageToSign).toMatch(/^Register Lighter Account\n\npubkey: 0x[0-9a-f]{80}\nnonce: 0x[0-9a-f]{16}\naccount index: 0x[0-9a-f]{16}\napi key index: 0x[0-9a-f]{16}\nOnly sign this message for a trusted client!$/);
        expect(r.txType).toBe(8);
        const info = JSON.parse(r.txInfo);
        expect(info.Nonce).toBe(nonce);
        expect(info.AccountIndex).toBe(account);
        expect(info.ApiKeyIndex).toBe(idx);
        expect(info.L1Sig ?? "").toBe(""); // the wallet signature goes in later (todo 11)
      }
      await expect(s.signChangePubKey({ pubKeyHex: "0x1234", nonce: 1, apiKeyIndex: 4, accountIndex: 1 })).rejects.toThrow(/80 hex/);
      s.close();
    }
  });
});
