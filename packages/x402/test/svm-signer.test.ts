// The Solana sponsor keystore round-trips, refuses a wrong password, and the broadcast tracker reports the tx id
// before the send (so a crash after broadcast still leaves a settlement_pending row).
import { describe, expect, test } from "bun:test";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import type { FacilitatorSvmSigner } from "@x402/svm";
import { decryptSvmKeystore, encryptSvmKeystore, SvmKeystoreError, trackSvmBroadcast } from "../src/svm-signer";

async function secret(label: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`capstan-x402-svm-ks:${label}`))); // test-key (public label)
}

describe("svm sponsor keystore", () => {
  test("round-trip and wrong password", async () => {
    const s = await secret("a");
    const want = (await createKeyPairSignerFromPrivateKeyBytes(s.slice())).address;
    const json = await encryptSvmKeystore(s.slice(), "pw-1", { n: 1024 });
    expect(json).not.toContain(Buffer.from(s).toString("hex"));
    expect((await decryptSvmKeystore(json, "pw-1")).address).toBe(want);
    await expect(decryptSvmKeystore(json, "pw-2")).rejects.toBeInstanceOf(SvmKeystoreError);
    await expect(decryptSvmKeystore("{}", "pw-1")).rejects.toBeInstanceOf(SvmKeystoreError);
  });

  test("tracker reports before send", async () => {
    const order: string[] = [];
    const inner = {
      getAddresses: () => [],
      signTransaction: async (t: string) => t,
      simulateTransaction: async () => {},
      sendTransaction: async () => {
        order.push("send");
        return "sig";
      },
      confirmTransaction: async () => {},
    } as unknown as FacilitatorSvmSigner;
    // a minimal legacy wire tx: 1 signature (64 bytes of 7), then a message we never parse past the header
    const sig = new Uint8Array(64).fill(7);
    const msg = new Uint8Array([1, 0, 0, 1, ...new Uint8Array(32).fill(1), ...new Uint8Array(32).fill(2), 0]);
    const wire = Buffer.from(new Uint8Array([1, ...sig, ...msg])).toString("base64");
    const tracked = trackSvmBroadcast(inner, (s) => void order.push(`hook:${s.length > 40 ? "base58" : s}`));
    await tracked.sendTransaction(wire, "solana:devnet");
    expect(order).toEqual(["hook:base58", "send"]);
  });
});
