// L1 action hashing (orders, cancels): msgpack(action) || nonce(8 BE) || vault flag [|| 0x00 expiresAfter(8 BE)],
// keccak256 = connectionId, signed through the phantom agent Agent(string source,bytes32 connectionId) on the
// Exchange/1/1337/0x0 domain. Source "a" is mainnet, "b" testnet (venue-hyperliquid.md section 6).
import { encode } from "@msgpack/msgpack";
import type { Hex, TypedDataPayload } from "@capstan/schema";
import { concatBytes, fromHex, keccakHex, lowerAddress, toHex, uintBE } from "./bytes";
import { hashTypedPayload } from "./eip712";
import type { HlL1Action, HlNetwork } from "./types";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export const PHANTOM_DOMAIN = { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO_ADDRESS } as const;

export const PHANTOM_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};

export function phantomSource(network: HlNetwork): "a" | "b" {
  if (network === "Mainnet") return "a";
  if (network === "Testnet") return "b";
  throw new Error(`hl-signer: unknown network ${String(network)}`);
}

const CLOID = /^0x[0-9a-fA-F]{32}$/;

/**
 * Copy of the action with every address (and cloid) lowercased, keeping the key order exactly as built. Lowercasing is
 * a docs pitfall: the venue hashes the lowercase form.
 */
export function lowercaseAction<T>(action: T): T {
  const walk = (v: unknown, key: string | null): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k);
      return out;
    }
    if (typeof v === "string" && key !== null) {
      if ((key === "b" || key === "builder" || key === "vaultAddress") && /^0x[0-9a-fA-F]{40}$/.test(v)) return v.toLowerCase();
      if ((key === "c" || key === "cloid") && CLOID.test(v)) return v.toLowerCase();
    }
    return v;
  };
  return walk(action, null) as T;
}

/** msgpack of the action: key order exactly as built, smallest integer encoding, undefined keys dropped. */
export function actionMsgpack(action: HlL1Action): Uint8Array {
  return encode(lowercaseAction(action), { ignoreUndefined: true });
}

/** The bytes keccak256 is taken over. Exported for byte-offset diagnostics in tests. */
export function actionHashPreimage(action: HlL1Action, vaultAddress: Hex | null, nonce: number, expiresAfter?: number): Uint8Array {
  const parts: Uint8Array[] = [actionMsgpack(action), uintBE(nonce, 8)];
  if (vaultAddress === null || vaultAddress === undefined) parts.push(new Uint8Array([0]));
  else parts.push(new Uint8Array([1]), fromHex(lowerAddress(vaultAddress)));
  if (expiresAfter !== undefined && expiresAfter !== null) parts.push(new Uint8Array([0]), uintBE(expiresAfter, 8));
  return concatBytes(...parts);
}

/** connectionId = keccak256(msgpack(action) || nonce || vault [|| expiresAfter]). */
export function actionHash(action: HlL1Action, vaultAddress: Hex | null, nonce: number, expiresAfter?: number): Hex {
  return keccakHex(actionHashPreimage(action, vaultAddress, nonce, expiresAfter));
}

export function phantomAgentTypedData(connectionId: Hex, network: HlNetwork): TypedDataPayload {
  if (!/^0x[0-9a-fA-F]{64}$/.test(connectionId)) throw new Error("hl-signer: connectionId must be 32 bytes");
  return {
    domain: { ...PHANTOM_DOMAIN },
    types: { EIP712Domain: [...PHANTOM_TYPES.EIP712Domain], Agent: [...PHANTOM_TYPES.Agent] },
    primaryType: "Agent",
    message: { source: phantomSource(network), connectionId: connectionId.toLowerCase() },
  };
}

/** The EIP-712 digest the agent key signs for an L1 action. */
export function l1Digest(action: HlL1Action, vault: Hex | null, nonce: number, network: HlNetwork, expiresAfter?: number): Hex {
  return hashTypedPayload(phantomAgentTypedData(actionHash(action, vault, nonce, expiresAfter), network));
}

export { toHex };
