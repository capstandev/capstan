// R5: onboarding is active only when apikeys returns our public key (compared without 0x) at the chosen index.
import { describe, expect, test } from "bun:test";
import { verifyOnboarding } from "../../src";

const PUB = "0x" + "c3".repeat(40);
const reader = (keys: { apiKeyIndex: number; publicKey: string }[]) => ({ apiKeys: async () => keys });
const id = { venue: "lighter-mainnet" as const, owner: "0x00000000000000000000000000000000000A11CE" as const, accountIndex: 99, apiKeyIndex: 7, pubKey: PUB };

describe("verify onboarding", () => {
  test("pubkey-at-index", async () => {
    expect((await verifyOnboarding(reader([{ apiKeyIndex: 7, publicKey: "c3".repeat(40) }]), id)).agentActive).toBe(true); // venue omits 0x
    expect((await verifyOnboarding(reader([{ apiKeyIndex: 7, publicKey: "C3".repeat(40) }]), id)).agentActive).toBe(true); // case-insensitive
    expect((await verifyOnboarding(reader([{ apiKeyIndex: 8, publicKey: "c3".repeat(40) }]), id)).agentActive).toBe(false); // wrong index
    expect((await verifyOnboarding(reader([{ apiKeyIndex: 7, publicKey: "c4".repeat(40) }]), id)).agentActive).toBe(false); // another key
    expect((await verifyOnboarding(reader([]), id)).agentActive).toBe(false);
    expect((await verifyOnboarding(reader([{ apiKeyIndex: 7, publicKey: "0".repeat(80) }]), { ...id, pubKey: "0".repeat(80) })).agentActive).toBe(false); // empty slot
    await expect(verifyOnboarding(reader([]), { ...id, apiKeyIndex: undefined })).rejects.toThrow();
  });
});
