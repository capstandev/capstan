// Every third-party chain id and address Capstan uses, in one file. Each entry names the research section that
// verified it live (read-only RPC calls) and the date. Our own contract addresses live in contracts/deployments/.
// A named test (packages/schema/test/constants.test.ts) checks every entry carries a source.
import type { Hex } from "../adapter";

export interface Sourced {
  source: string; // "<research file> §<section>, <YYYY-MM-DD>"
}
export interface ChainConst extends Sourced {
  chainId: number;
  caip2: string;
  name: string;
  publicRpc: string;
}
export interface AddressConst extends Sourced {
  chainId: number | string; // EVM chain id, or a CAIP-2 id for Solana
  address: Hex | string;
  symbol?: string;
  decimals?: number;
  note?: string;
}

export const CHAINS = {
  rhc: { chainId: 4663, caip2: "eip155:4663", name: "Robinhood Chain", publicRpc: "https://rpc.mainnet.chain.robinhood.com", source: "chain-facts.md §1, 2026-11-05" },
  rhcTestnet: { chainId: 46630, caip2: "eip155:46630", name: "Robinhood Chain Testnet", publicRpc: "https://rpc.testnet.chain.robinhood.com", source: "chain-facts.md §1, 2026-11-05" },
  base: { chainId: 8453, caip2: "eip155:8453", name: "Base", publicRpc: "https://mainnet.base.org", source: "chain-facts.md §7, 2026-11-05" },
  baseSepolia: { chainId: 84532, caip2: "eip155:84532", name: "Base Sepolia", publicRpc: "https://sepolia.base.org", source: "chain-facts.md §7, 2026-11-05" },
  solana: { chainId: 0, caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZ", name: "Solana", publicRpc: "https://api.mainnet-beta.solana.com", source: "chain-facts.md §8, 2026-11-05" },
  solanaDevnet: { chainId: 0, caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", name: "Solana Devnet", publicRpc: "https://api.devnet.solana.com", source: "chain-facts.md §8, 2026-11-05" },
} as const satisfies Record<string, ChainConst>;

/** Chain ids a service signer may ever send on outside production (tests and testnets). */
export const LOCAL_CHAIN_ID = 31337 as const;
export const TESTNET_CHAIN_IDS = [31337, 46630, 84532] as const;
export const MAINNET_CHAIN_IDS = [4663, 8453] as const;

export const ADDRESSES = {
  // Tokens
  usdgRhc: { chainId: 4663, address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6, note: "EIP-1967 proxy over a facet router; EIP-712 name 'Global Dollar', version '1' (version() reverts)", source: "chain-facts.md §3, 2026-11-05" },
  usdgRhcTestnet: { chainId: 46630, address: "0x7E955252E15c84f5768B83c41a71F9eba181802F", symbol: "USDG", decimals: 6, note: "EIP-712 name 'Global Dollar', version '1'", source: "chain-facts.md §3, 2026-11-05" },
  usdcBase: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6, note: "EIP-712 name 'USD Coin', version '2'", source: "chain-facts.md §7, 2026-11-05" },
  usdcBaseSepolia: { chainId: 84532, address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6, note: "EIP-712 name 'USDC', version '2'", source: "chain-facts.md §7, 2026-11-05" },
  usdcSolana: { chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZ", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6, note: "classic SPL Token program", source: "chain-facts.md §8, 2026-11-05" },
  usdcSolanaDevnet: { chainId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", decimals: 6, source: "chain-facts.md §8, 2026-11-05" },
  wethRhc: { chainId: 4663, address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", decimals: 18, note: "no code at this address on testnet", source: "chain-facts.md §4, 2026-11-05" },
  // Permit2 and the x402 Permit2 proxy (same address on every chain)
  permit2: { chainId: 4663, address: "0x000000000022D473030F116dDEE9F6B43aC78BA3", note: "same address on 46630, 8453, 84532", source: "chain-facts.md §3.2, 2026-11-05" },
  x402Permit2Proxy: { chainId: 4663, address: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001", note: "CREATE2, same address on 46630, 8453, 84532", source: "x402-and-stack.md §2.4, 2026-11-05" },
  // Uniswap on RHC (monthly burn buy, depeg monitor)
  universalRouterRhc: { chainId: 4663, address: "0x8876789976decbfcbbbe364623c63652db8c0904", note: "also on 46630", source: "chain-facts.md §4, 2026-11-05" },
  v4PoolManagerRhc: { chainId: 4663, address: "0x8366a39cc670b4001a1121b8f6a443a643e40951", note: "also on 46630", source: "chain-facts.md §4, 2026-11-05" },
  v4QuoterRhc: { chainId: 4663, address: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94", note: "also on 46630", source: "chain-facts.md §4, 2026-11-05" },
  v4StateViewRhc: { chainId: 4663, address: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b", note: "also on 46630", source: "chain-facts.md §4, 2026-11-05" },
  // Safe 1.4.1 canonical deployments (brand Safe check, contracts/script/lib/SafeCheck.sol)
  safe141: { chainId: 4663, address: "0x41675C099F32341bf84BFc5382aF534df5C7461a", note: "Safe 1.4.1 singleton; also on 46630", source: "chain-facts.md §2, 2026-11-06" },
  safeL2141: { chainId: 4663, address: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", note: "SafeL2 1.4.1 singleton; also on 46630", source: "chain-facts.md §2, 2026-11-06" },
  safeProxyFactory141: { chainId: 4663, address: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", note: "SafeProxyFactory 1.4.1; also on 46630", source: "chain-facts.md §2, 2026-11-06" },
  safeFallbackHandler141: { chainId: 4663, address: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99", note: "CompatibilityFallbackHandler 1.4.1; also on 46630", source: "chain-facts.md §2, 2026-11-06" },
  v3FactoryRhc: { chainId: 4663, address: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", note: "mainnet only", source: "chain-facts.md §4, 2026-11-05" },
  v3QuoterV2Rhc: { chainId: 4663, address: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7", note: "mainnet only", source: "chain-facts.md §4, 2026-11-05" },
  v3WethUsdg001: { chainId: 4663, address: "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca", note: "WETH/USDG 0.01% (deepest)", source: "chain-facts.md §4, 2026-11-05" },
  v3WethUsdg005: { chainId: 4663, address: "0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a", note: "WETH/USDG 0.05%", source: "chain-facts.md §4, 2026-11-05" },
  v3WethUsdg030: { chainId: 4663, address: "0xa9188730Fe85Be88ad499D7d52B099e800fB0334", note: "WETH/USDG 0.3%", source: "chain-facts.md §4, 2026-11-05" },
  v3WethUsdg100: { chainId: 4663, address: "0x5f009E071F07e92B6C624e83F52F17bBDa34680D", note: "WETH/USDG 1%", source: "chain-facts.md §4, 2026-11-05" },
  // Chainlink proxies on RHC (8 decimals; heartbeat 86400 s, deviation 0.5%: a coarse cross-check only)
  chainlinkUsdgUsd: { chainId: 4663, address: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2", decimals: 8, source: "chain-facts.md §5, 2026-11-05" },
  chainlinkUsdcUsd: { chainId: 4663, address: "0x9e6f4605992a899eE2999999F3Ec80C41F452546", decimals: 8, source: "chain-facts.md §5, 2026-11-05" },
  chainlinkUsdtUsd: { chainId: 4663, address: "0xbf3550B6fAe1671da7C238Af12e03Ac586BEf3B1", decimals: 8, source: "chain-facts.md §5, 2026-11-05" },
  chainlinkEthUsd: { chainId: 4663, address: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9", decimals: 8, source: "chain-facts.md §5, 2026-11-05" },
  chainlinkBtcUsd: { chainId: 4663, address: "0xa2c5184bF03d373Dc9dE4876eb4Bce595B460251", decimals: 8, source: "chain-facts.md §5, 2026-11-05" },
  // Venue contracts
  lighterRhDeposit: { chainId: 4663, address: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d", note: "ERC-1967 proxy; re-read from Lighter-RH GET /info at boot and refuse deposit builds on mismatch", source: "venue-lighter.md §deposit-contract, 2026-11-05" },
  lighterRhDepositImpl: { chainId: 4663, address: "0x998ecf039eb110b72f5f6c1ea31c2fa41a458faa", note: "EIP-1967 implementation of lighterRhDeposit at the pin; the nightly health job alerts when the slot changes", source: "venue-lighter.md §deposit-contract, 2026-11-05" },
  lighterMainnetL1: { chainId: 1, address: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7", note: "Lighter contract on Ethereum (from GET /info)", source: "venue-lighter.md §configs, 2026-11-05" },
} as const satisfies Record<string, AddressConst>;

export type AddressName = keyof typeof ADDRESSES;
