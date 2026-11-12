// CapstanAgentPolicy v1 (spec 7.6): EIP-712 typed data signed by the MAIN wallet. The chain id scopes the domain only
// (nothing is sent to a chain). Times are unix milliseconds as uint64 (reduceOnlyAfter 0 = none); allowedMarkets '*'
// is encoded as ["*"], so a policy and its digest are one to one. The message is plain JSON (uint64 times are safe
// integer numbers, never BigInt): it travels in the onboarding bundle, is stored as jsonb and goes to the wallet as
// eth_signTypedData_v4 JSON. EIP-712 hashes a number and the same BigInt alike, so the digest does not change.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { AgentPolicy, Hex, TypedDataPayload } from "@capstan/schema";
import { bytesToHex, hashTypedData, hexToBytes } from "viem";
import { publicKeyToAddress } from "viem/accounts";

export const POLICY_CHAIN_ID = 4663;
export const POLICY_DOMAIN = { name: "CapstanAgentPolicy", version: "1" } as const;

export const POLICY_TYPES = {
  AgentPolicy: [
    { name: "owner", type: "address" },
    { name: "agents", type: "Agent[]" },
    { name: "maxNotionalPerOrderUsd", type: "string" },
    { name: "maxGrossNotionalUsd", type: "string" },
    { name: "maxLeverage", type: "uint32" },
    { name: "allowedMarkets", type: "string[]" },
    { name: "allowedVenues", type: "string[]" },
    { name: "maxOrdersPerDay", type: "uint32" },
    { name: "reduceOnlyAfter", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "string" },
  ],
  Agent: [
    { name: "venue", type: "string" },
    { name: "agentRef", type: "string" },
  ],
} as const;

export class PolicyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyFormatError";
  }
}

/** ISO time (or a unix ms digit string) to unix ms; throws on anything else. */
export function policyTimeMs(x: string): number {
  const n = /^\d{1,16}$/.test(x) ? Number(x) : Date.parse(x);
  if (!Number.isSafeInteger(n) || n < 0) throw new PolicyFormatError(`not a time: ${JSON.stringify(x).slice(0, 40)}`);
  return n;
}

function uint32(n: number, field: string): number {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new PolicyFormatError(`${field} must be a uint32 integer`);
  return n;
}

export function policyMessage(p: AgentPolicy): Record<string, unknown> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.owner)) throw new PolicyFormatError("owner must be an address");
  return {
    owner: p.owner,
    agents: p.agents.map((a) => ({ venue: a.venue, agentRef: a.agentRef })),
    maxNotionalPerOrderUsd: p.maxNotionalPerOrderUsd,
    maxGrossNotionalUsd: p.maxGrossNotionalUsd,
    maxLeverage: uint32(p.maxLeverage, "maxLeverage"),
    allowedMarkets: p.allowedMarkets === "*" ? ["*"] : [...p.allowedMarkets],
    allowedVenues: [...p.allowedVenues],
    maxOrdersPerDay: uint32(p.maxOrdersPerDay, "maxOrdersPerDay"),
    reduceOnlyAfter: p.reduceOnlyAfter === undefined || p.reduceOnlyAfter === "" ? 0 : policyTimeMs(p.reduceOnlyAfter),
    expiresAt: policyTimeMs(p.expiresAt),
    nonce: p.nonce,
  };
}

export function policyTypedData(p: AgentPolicy): TypedDataPayload {
  return {
    domain: { ...POLICY_DOMAIN, chainId: POLICY_CHAIN_ID },
    types: POLICY_TYPES as unknown as TypedDataPayload["types"],
    primaryType: "AgentPolicy",
    message: policyMessage(p),
  };
}

export function policyDigest(p: AgentPolicy): Hex {
  const td = policyTypedData(p);
  const hash = hashTypedData as unknown as (x: { domain: unknown; types: unknown; primaryType: string; message: unknown }) => Hex;
  return hash({ domain: td.domain, types: td.types, primaryType: "AgentPolicy", message: td.message });
}

const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n; // secp256k1 n / 2, public curve constant // not-a-key

/** Recover the signer of a 32-byte digest from a 65-byte r||s||v signature; null when malformed or high-S. */
export function recoverDigestSigner(digest: Hex, sig: Hex): Hex | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return null;
  try {
    const raw = hexToBytes(sig);
    let v = raw[64]!;
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;
    const s = BigInt(bytesToHex(raw.slice(32, 64)));
    if (s > HALF_N) return null; // malleable form refused
    const rec = new Uint8Array(65);
    rec[0] = v;
    rec.set(raw.slice(0, 64), 1);
    const pub = secp256k1.recoverPublicKey(rec, hexToBytes(digest), { prehash: false });
    return publicKeyToAddress(bytesToHex(secp256k1.Point.fromBytes(pub).toBytes(false)));
  } catch {
    return null;
  }
}

/** True when the signature over the policy's typed data recovers to p.owner. */
export function verifyPolicySig(p: AgentPolicy, sig: Hex): boolean {
  let digest: Hex;
  try {
    digest = policyDigest(p);
  } catch {
    return false;
  }
  const signer = recoverDigestSigner(digest, sig);
  return signer !== null && signer.toLowerCase() === p.owner.toLowerCase();
}
