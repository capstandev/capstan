// Shared policy fixtures for the policy tests and the api route tests.
import type { AgentPolicy } from "@capstan/schema";
import { testWallet } from "./accounts";

export const VECTOR_OWNER = testWallet("vector owner");

/** The committed vector policy (R1). Changing any field changes VECTOR.digest. */
export const VECTOR_POLICY: AgentPolicy = {
  owner: "0x4A97a91F22c43f2e75C0fd793D19efC73288F744",
  agents: [
    { venue: "hyperliquid", agentRef: "hl-agent-1" },
    { venue: "aster", agentRef: "aster-agent-1" },
  ],
  maxNotionalPerOrderUsd: "2500.50",
  maxGrossNotionalUsd: "10000",
  maxLeverage: 5,
  allowedMarkets: ["hyperliquid:-:ETH", "aster:-:ETHUSDT"],
  allowedVenues: ["hyperliquid", "aster"],
  maxOrdersPerDay: 200,
  reduceOnlyAfter: "2026-12-01T00:00:00.000Z",
  expiresAt: "2026-12-31T00:00:00.000Z",
  nonce: "policy-vector-0001",
};

export const VECTOR = {
  digest: "0x34f681d632a7fdfabe57bfdf69be01687de15995b2b2d0b32ee38569c2b24f33", // not-a-key (EIP-712 digest)
  sig: "0x1acf08b47a7a51777c5bab8fdf8b61a20dee7dd98d87bd11962a86ef333cb0b0541dada64a06d3fccb8df3b7c4c45f23e0a118cf08898ad039ba1cc9645de4ff1c", // not-a-key (signature)
} as const;

export const NOW = Date.parse("2026-11-01T12:00:00.000Z");

export function basePolicy(owner: `0x${string}`, over: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    owner,
    agents: [{ venue: "hyperliquid", agentRef: "agent-a" }],
    maxNotionalPerOrderUsd: "1000",
    maxGrossNotionalUsd: "5000",
    maxLeverage: 5,
    allowedMarkets: ["hyperliquid:-:ETH", "hyperliquid:-:BTC"],
    allowedVenues: ["hyperliquid"],
    maxOrdersPerDay: 10,
    expiresAt: new Date(NOW + 86_400_000).toISOString(),
    nonce: `nonce-${Math.random().toString(36).slice(2, 12)}`,
    ...over,
  };
}
