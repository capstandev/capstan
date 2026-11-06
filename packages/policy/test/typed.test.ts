// R1: CapstanAgentPolicy typed data is stable. The committed vector (policy JSON, digest, signature by a test wallet
// derived from a public label) reproduces, and any field change changes the digest.
import { describe, expect, test } from "bun:test";
import type { AgentPolicy } from "@capstan/schema";
import { recoverTypedDataAddress } from "viem";
import { POLICY_DOMAIN, policyDigest, policyTypedData, verifyPolicySig } from "../src";
import { testWallet } from "./accounts";
import { VECTOR, VECTOR_OWNER, VECTOR_POLICY } from "./fixtures";

describe("typed data", () => {
  test("vector-and-tamper", async () => {
    expect(VECTOR_OWNER.address).toBe(VECTOR_POLICY.owner);
    const td = policyTypedData(VECTOR_POLICY);
    expect(td.domain).toEqual({ ...POLICY_DOMAIN, chainId: 4663 });
    expect(td.primaryType).toBe("AgentPolicy");
    expect(policyDigest(VECTOR_POLICY)).toBe(VECTOR.digest);
    // the signature reproduces (RFC 6979 is deterministic) and recovers through both our path and viem's
    expect(await VECTOR_OWNER.signTypedData(td as never)).toBe(VECTOR.sig);
    expect(verifyPolicySig(VECTOR_POLICY, VECTOR.sig)).toBe(true);
    expect(await recoverTypedDataAddress({ ...(td as object), signature: VECTOR.sig } as never)).toBe(VECTOR_POLICY.owner);
    // '*' is encoded as ["*"]
    expect(policyTypedData({ ...VECTOR_POLICY, allowedMarkets: "*" }).message.allowedMarkets).toEqual(["*"]);
    expect(policyDigest({ ...VECTOR_POLICY, allowedMarkets: "*" })).toBe(policyDigest({ ...VECTOR_POLICY, allowedMarkets: ["*"] }));

    // every field change changes the digest and breaks the signature
    const tampers: [string, Partial<AgentPolicy>][] = [
      ["owner", { owner: testWallet("someone else").address }],
      ["agents.venue", { agents: [{ venue: "lighter-mainnet", agentRef: "hl-agent-1" }, VECTOR_POLICY.agents[1]!] }],
      ["agents.agentRef", { agents: [{ venue: "hyperliquid", agentRef: "hl-agent-2" }, VECTOR_POLICY.agents[1]!] }],
      ["agents.order", { agents: [VECTOR_POLICY.agents[1]!, VECTOR_POLICY.agents[0]!] }],
      ["maxNotionalPerOrderUsd", { maxNotionalPerOrderUsd: "2500.51" }],
      ["maxGrossNotionalUsd", { maxGrossNotionalUsd: "10001" }],
      ["maxLeverage", { maxLeverage: 6 }],
      ["allowedMarkets", { allowedMarkets: ["hyperliquid:-:ETH"] }],
      ["allowedMarkets *", { allowedMarkets: "*" }],
      ["allowedVenues", { allowedVenues: ["hyperliquid"] }],
      ["maxOrdersPerDay", { maxOrdersPerDay: 201 }],
      ["reduceOnlyAfter", { reduceOnlyAfter: "2026-12-01T00:00:00.001Z" }],
      ["reduceOnlyAfter none", { reduceOnlyAfter: undefined }],
      ["expiresAt", { expiresAt: "2026-12-31T00:00:01.000Z" }],
      ["nonce", { nonce: "policy-vector-0002" }],
    ];
    const seen = new Set<string>([VECTOR.digest]);
    for (const [name, change] of tampers) {
      const p = { ...VECTOR_POLICY, ...change } as AgentPolicy;
      const dg = policyDigest(p);
      expect(seen.has(dg), name).toBe(false);
      seen.add(dg);
      expect(verifyPolicySig(p, VECTOR.sig), name).toBe(false);
    }
    // another signer, a malformed or a high-S signature never verifies
    const other = await testWallet("someone else").signTypedData(td as never);
    expect(verifyPolicySig(VECTOR_POLICY, other)).toBe(false);
    expect(verifyPolicySig(VECTOR_POLICY, "0x1234")).toBe(false);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // curve order // not-a-key
    const s = BigInt(`0x${VECTOR.sig.slice(66, 130)}`);
    const v = Number.parseInt(VECTOR.sig.slice(130), 16);
    const highS = `${VECTOR.sig.slice(0, 66)}${(n - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}` as `0x${string}`;
    expect(verifyPolicySig(VECTOR_POLICY, highS)).toBe(false);
  });
});
