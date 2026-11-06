// R10 and R12.
import { describe, expect, test } from "bun:test";
import { agentNameWithExpiry, parseAgentName, postBody, recoverSigner, signDigest, userSignedDigest, addressOf, type HlUserAction } from "../src";
import { testKeyFrom } from "./helpers";

const NOW = 1793900000000;
const DAY = 86_400_000;

describe("agent", () => {
  test("expiry-bounds", () => {
    expect(agentNameWithExpiry("cpst-abc123", NOW + 90 * DAY, NOW)).toBe(`cpst-abc123 valid_until ${NOW + 90 * DAY}`);
    expect(agentNameWithExpiry("cpst-abc123", NOW + 180 * DAY, NOW)).toBe(`cpst-abc123 valid_until ${NOW + 180 * DAY}`);
    expect(() => agentNameWithExpiry("cpst-abc123", NOW + 180 * DAY + 1, NOW)).toThrow(/180 days/);
    expect(() => agentNameWithExpiry("cpst-abc123", NOW, NOW)).toThrow(/past/);
    expect(() => agentNameWithExpiry("cpst-abc123", NOW - 1, NOW)).toThrow(/past/);
    expect(() => agentNameWithExpiry("", NOW + DAY, NOW)).toThrow();
    expect(parseAgentName(`cpst-abc123 valid_until ${NOW + DAY}`)).toEqual({ name: "cpst-abc123", validUntil: NOW + DAY });
  });

  test("unnamed-agent-body", () => {
    const key = testKeyFrom("unnamed-main");
    const a: HlUserAction = { type: "approveAgent", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", agentAddress: "0x00000000000000000000000000000000a9e17001", agentName: "", nonce: NOW };
    const digest = userSignedDigest(a);
    const sig = signDigest(digest, key);
    const body = postBody(a, sig, NOW);
    expect("agentName" in body.action).toBe(false);
    expect(body.action.type).toBe("approveAgent");
    expect(body.action.signatureChainId).toBe("0x66eee");
    expect(body.vaultAddress).toBeNull();
    // the signature still recovers over the struct with agentName ""
    expect(recoverSigner(digest, body.signature)).toBe(addressOf(key));
    // a named agent keeps the key
    const named = postBody({ ...a, agentName: "cpst-abc123" }, sig, NOW);
    expect(named.action.agentName).toBe("cpst-abc123");
  });
});
