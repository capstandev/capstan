// Runtime EIP-3009 detection for a token (USDG on RHC). Fail closed: any revert, RPC error or mismatch means absent.
// USDG is a facet router: version() and eip712Domain() revert FacetNotFound, so this module NEVER sends them. The
// domain version is hard-coded ("1") and proven by recomputing the EIP-712 domain separator and comparing it with
// DOMAIN_SEPARATOR() on chain.
import type { Hex } from "@capstan/schema";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, stringToHex, toFunctionSelector, type PublicClient } from "viem";

export const TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
  stringToHex("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
);
const EIP712_DOMAIN_TYPEHASH = keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));

/** Selectors this module must never send (both revert on USDG). Exported so tests can spy for them. */
export const FORBIDDEN_SELECTORS = {
  version: toFunctionSelector("version()"),
  eip712Domain: toFunctionSelector("eip712Domain()"),
} as const;

/** Custom error selector of the USDG facet router for an unknown function. */
export const FACET_NOT_FOUND = "0x800ab12c";

const ABI = parseAbi([
  "function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

export interface DetectionResult {
  supported: boolean;
  reason: string;
  checkedAt: number;
}

export type ReadClient = Pick<PublicClient, "call">;

/** EIP-712 domain separator for (name, version, chainId, verifyingContract). */
export function domainSeparator(name: string, version: string, chainId: number, verifyingContract: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [EIP712_DOMAIN_TYPEHASH, keccak256(stringToHex(name)), keccak256(stringToHex(version)), BigInt(chainId), verifyingContract],
    ),
  );
}

function revertReason(err: unknown): string {
  const seen = new Set<unknown>();
  let e: unknown = err;
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e);
    const data = (e as { data?: unknown }).data;
    if (typeof data === "string" && data.toLowerCase().startsWith(FACET_NOT_FOUND)) return "FacetNotFound";
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === "string" && msg.toLowerCase().includes(FACET_NOT_FOUND.slice(2))) return "FacetNotFound";
    e = (e as { cause?: unknown }).cause;
  }
  return "revert or rpc error";
}

async function call32(rpc: ReadClient, to: Hex, data: Hex): Promise<Hex> {
  const r = await rpc.call({ to, data });
  if (!r.data || r.data.length < 66) throw new Error("empty return");
  return r.data;
}

export async function detectEip3009(
  rpc: ReadClient,
  token: Hex,
  expected: { name: string; version: string; chainId: number },
  now: () => number = Date.now,
): Promise<DetectionResult> {
  const out = (supported: boolean, reason: string): DetectionResult => ({ supported, reason, checkedAt: now() });
  try {
    let step = "TRANSFER_WITH_AUTHORIZATION_TYPEHASH";
    try {
      const th = await call32(rpc, token, encodeFunctionData({ abi: ABI, functionName: "TRANSFER_WITH_AUTHORIZATION_TYPEHASH" }));
      const [typehash] = decodeAbiParameters([{ type: "bytes32" }], th);
      if (typehash.toLowerCase() !== TRANSFER_WITH_AUTHORIZATION_TYPEHASH.toLowerCase()) return out(false, "typehash differs from the EIP-3009 standard");
      step = "authorizationState";
      const st = await call32(
        rpc,
        token,
        encodeFunctionData({ abi: ABI, functionName: "authorizationState", args: ["0x0000000000000000000000000000000000000001", `0x${"00".repeat(32)}`] }),
      );
      decodeAbiParameters([{ type: "bool" }], st);
      step = "DOMAIN_SEPARATOR";
      const ds = await call32(rpc, token, encodeFunctionData({ abi: ABI, functionName: "DOMAIN_SEPARATOR" }));
      const [onChain] = decodeAbiParameters([{ type: "bytes32" }], ds);
      const computed = domainSeparator(expected.name, expected.version, expected.chainId, token);
      if (onChain.toLowerCase() !== computed.toLowerCase()) {
        return out(false, `DOMAIN_SEPARATOR does not match name "${expected.name}" version "${expected.version}" chain ${expected.chainId}`);
      }
      return out(true, `EIP-3009 present; domain "${expected.name}" v${expected.version} matches DOMAIN_SEPARATOR`);
    } catch (err) {
      return out(false, `${step}: ${revertReason(err)}`);
    }
  } catch {
    return out(false, "detection failed");
  }
}
