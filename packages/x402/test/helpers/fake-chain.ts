// Fake read-only chain clients for x402 boot tests: ERC-20 token facts (name, version, decimals, DOMAIN_SEPARATOR),
// an optional EIP-3009 surface (typehash and authorizationState; otherwise FacetNotFound), a gas price and a fresh
// Chainlink ETH/USD answer. Nothing here talks to a network.
import type { Hex } from "@capstan/schema";
import { encodeAbiParameters, toFunctionSelector } from "viem";
import type { BootClient } from "../../src/boot";
import { domainSeparator, TRANSFER_WITH_AUTHORIZATION_TYPEHASH, type ReadClient } from "../../src/detect";
import { NETWORKS, railDefs } from "../../src/networks";

const defs = railDefs("testnet");

const SEL = {
  name: toFunctionSelector("name()"),
  version: toFunctionSelector("version()"),
  decimals: toFunctionSelector("decimals()"),
  domain: toFunctionSelector("DOMAIN_SEPARATOR()"),
  feed: toFunctionSelector("latestRoundData()"),
  typehash: toFunctionSelector("TRANSFER_WITH_AUTHORIZATION_TYPEHASH()"),
  authState: toFunctionSelector("authorizationState(address,bytes32)"),
};

/** A read-only token on a fake chain: ERC-20 facts, an optional EIP-3009 surface, a gas price and the ETH/USD feed. */
export function fakeChain(o: { chainId: number; token: Hex; name: string; version: string; eip3009: boolean }): BootClient {
  const call = async ({ to, data }: { to?: string | null; data?: string }) => {
    const sel = (data ?? "").slice(0, 10);
    if (sel === SEL.feed) {
      const now = BigInt(Math.floor(Date.now() / 1000));
      return { data: encodeAbiParameters([{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], [1n, 3000_00000000n, now, now, 1n]) };
    }
    if (to?.toLowerCase() !== o.token.toLowerCase()) throw new Error("no code at this address");
    if (sel === SEL.name) return { data: encodeAbiParameters([{ type: "string" }], [o.name]) };
    if (sel === SEL.version) return { data: encodeAbiParameters([{ type: "string" }], [o.version]) };
    if (sel === SEL.decimals) return { data: encodeAbiParameters([{ type: "uint8" }], [6]) };
    if (sel === SEL.domain) return { data: domainSeparator(o.name, o.version, o.chainId, o.token) };
    if (o.eip3009 && sel === SEL.typehash) return { data: TRANSFER_WITH_AUTHORIZATION_TYPEHASH };
    if (o.eip3009 && sel === SEL.authState) return { data: encodeAbiParameters([{ type: "bool" }], [false]) };
    throw Object.assign(new Error("execution reverted"), { data: "0x800ab12c" });
  };
  return { call: call as unknown as ReadClient["call"], getGasPrice: async () => 1_000_000n };
}

const baseUsdc = defs["base-usdc"];
const usdg = defs["rhc-usdg-permit2"];
/** Boot clients and detection RPCs for testnet: Base Sepolia USDC, RHC testnet USDG (EIP-3009 healthy or not), and an RHC mainnet client for the ETH/USD feed. */
export const fakeTestnetChains = (eip3009: boolean) => {
  const base = fakeChain({ chainId: 84532, token: baseUsdc.asset as Hex, name: baseUsdc.domain!.name, version: baseUsdc.domain!.version, eip3009: true });
  const rhcT = fakeChain({ chainId: 46630, token: usdg.asset as Hex, name: "Global Dollar", version: "1", eip3009 });
  const rhcMain = fakeChain({ chainId: 4663, token: "0x0000000000000000000000000000000000000001", name: "-", version: "-", eip3009: false });
  return { clients: { [NETWORKS.baseSepolia]: base, [NETWORKS.rhcTestnet]: rhcT, [NETWORKS.rhc]: rhcMain }, detectRpcs: { "46630": rhcT } };
};

