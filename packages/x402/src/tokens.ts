// Token facts for each EVM rail, read from chain at boot (decimals and the EIP-712 domain are never assumed).
// USDG: name() and decimals() are read; version() is never called (it reverts), the version "1" is proven against
// DOMAIN_SEPARATOR(). USDC: name(), version() and decimals() are read and proven against DOMAIN_SEPARATOR().
import type { Hex } from "@capstan/schema";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi } from "viem";
import { domainSeparator, type ReadClient } from "./detect";

export interface TokenInfo {
  asset: string;
  decimals: number;
  name: string;
  version: string;
}

const ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

async function read(rpc: ReadClient, token: Hex, fn: "name" | "version" | "decimals" | "DOMAIN_SEPARATOR"): Promise<unknown> {
  const abi = ABI as Abi;
  const r = await rpc.call({ to: token, data: encodeFunctionData({ abi, functionName: fn }) });
  if (!r.data || r.data === "0x") throw new Error(`${fn}: empty return`);
  return decodeFunctionResult({ abi, functionName: fn, data: r.data });
}

/**
 * Read and prove a token's EIP-712 domain. `hardVersion` set = never call version() (USDG); the given version must
 * reproduce DOMAIN_SEPARATOR(). Throws on any mismatch, so the caller drops the rail (fail closed).
 */
export async function readTokenInfo(rpc: ReadClient, token: Hex, chainId: number, opts: { hardVersion?: string; expectName?: string } = {}): Promise<TokenInfo> {
  const name = (await read(rpc, token, "name")) as string;
  if (opts.expectName !== undefined && name !== opts.expectName) throw new Error(`token name is "${name}", expected "${opts.expectName}"`);
  const version = opts.hardVersion ?? ((await read(rpc, token, "version")) as string);
  const decimals = Number(await read(rpc, token, "decimals"));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("token decimals out of range");
  const onChain = (await read(rpc, token, "DOMAIN_SEPARATOR")) as Hex;
  if (onChain.toLowerCase() !== domainSeparator(name, version, chainId, token).toLowerCase()) {
    throw new Error(`DOMAIN_SEPARATOR does not match name "${name}" version "${version}"`);
  }
  return { asset: token, decimals, name, version };
}
