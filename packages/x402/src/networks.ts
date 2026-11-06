// x402 networks (CAIP-2) and the payment rails Capstan accepts. Token addresses come from the one constants file
// (@capstan/schema ADDRESSES); this module only maps them onto x402 networks.
import { ADDRESSES, type Hex } from "@capstan/schema";

export const NETWORKS = {
  base: "eip155:8453",
  baseSepolia: "eip155:84532",
  rhc: "eip155:4663",
  rhcTestnet: "eip155:46630",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  solanaDevnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
} as const;

export type X402Network = (typeof NETWORKS)[keyof typeof NETWORKS];
export type EvmNetwork = typeof NETWORKS.base | typeof NETWORKS.baseSepolia | typeof NETWORKS.rhc | typeof NETWORKS.rhcTestnet;
export type SvmNetwork = typeof NETWORKS.solana | typeof NETWORKS.solanaDevnet;
export type X402Env = "mainnet" | "testnet";

export const EVM_CHAIN_IDS: Record<EvmNetwork, number> = {
  [NETWORKS.base]: 8453,
  [NETWORKS.baseSepolia]: 84532,
  [NETWORKS.rhc]: 4663,
  [NETWORKS.rhcTestnet]: 46630,
};

/** Networks where a settle moves real money. The facilitator refuses to broadcast on them unless armed. */
export const MAINNET_NETWORKS: readonly X402Network[] = [NETWORKS.base, NETWORKS.rhc, NETWORKS.solana];

export function isEvmNetwork(n: string): n is EvmNetwork {
  return n in EVM_CHAIN_IDS;
}
export function isSvmNetwork(n: string): n is SvmNetwork {
  return n === NETWORKS.solana || n === NETWORKS.solanaDevnet;
}
export function networkForChainId(chainId: number): EvmNetwork | null {
  for (const [n, id] of Object.entries(EVM_CHAIN_IDS)) if (id === chainId) return n as EvmNetwork;
  return null;
}

/** The four rails, in the order they are offered (DECISIONS #16: Base USDC first, then Solana USDC, then RHC USDG). */
export const RAIL_IDS = ["base-usdc", "solana-usdc", "rhc-usdg-permit2", "rhc-usdg-eip3009"] as const;
export type RailId = (typeof RAIL_IDS)[number];
export type TransferMethod = "eip3009" | "permit2" | "spl";

export interface RailDef {
  id: RailId;
  network: X402Network;
  asset: string;
  method: TransferMethod;
  /** EIP-712 domain name/version the token is expected to use (EVM only). Verified live, never trusted blindly. */
  domain?: { name: string; version: string };
}

const USDG_DOMAIN = { name: "Global Dollar", version: "1" } as const;

/** Rail definitions per environment. Base USDC domain names differ per net ("USD Coin" vs "USDC"). */
export function railDefs(env: X402Env): Record<RailId, RailDef> {
  const main = env === "mainnet";
  const usdg = (main ? ADDRESSES.usdgRhc : ADDRESSES.usdgRhcTestnet).address as Hex;
  const rhc = main ? NETWORKS.rhc : NETWORKS.rhcTestnet;
  return {
    "base-usdc": {
      id: "base-usdc",
      network: main ? NETWORKS.base : NETWORKS.baseSepolia,
      asset: (main ? ADDRESSES.usdcBase : ADDRESSES.usdcBaseSepolia).address,
      method: "eip3009",
      domain: { name: main ? "USD Coin" : "USDC", version: "2" },
    },
    "solana-usdc": {
      id: "solana-usdc",
      network: main ? NETWORKS.solana : NETWORKS.solanaDevnet,
      asset: (main ? ADDRESSES.usdcSolana : ADDRESSES.usdcSolanaDevnet).address,
      method: "spl",
    },
    "rhc-usdg-permit2": { id: "rhc-usdg-permit2", network: rhc, asset: usdg, method: "permit2", domain: { ...USDG_DOMAIN } },
    "rhc-usdg-eip3009": { id: "rhc-usdg-eip3009", network: rhc, asset: usdg, method: "eip3009", domain: { ...USDG_DOMAIN } },
  };
}

export const X402_PERMIT2_PROXY = ADDRESSES.x402Permit2Proxy.address as Hex;
export const PERMIT2 = ADDRESSES.permit2.address as Hex;
/** Standard x402 batch-settlement contract (evaluated in BATCHING.md, not used in v1). */
export const X402_BATCH_SETTLEMENT = "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003" as Hex;
