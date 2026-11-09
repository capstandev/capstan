// Build-time configuration (Vite env, VITE_* only) and the React context that carries it. Tests pass their own config.
// Profiles: "live" (the public site; mainnet pins) and "fork" (the local stack and an anvil fork on this lane's ports,
// with a plain "Local test network" banner and no writes from chain 4663).
import { createContext, useContext } from "react";
import type { KeyStore, Network, PinsOverride, VenueId, Hex } from "./lib/capstan";

export type Profile = "live" | "fork";

export interface AppConfig {
  profile: Profile;
  /** Capstan API base, ending in /v1. */
  apiBase: string;
  network: Network;
  /** JSON-RPC used for the anchor read on /verify and the token box chain. */
  rpcUrl: string;
  /** Chain whose contracts.json entry the token box reads (4663 live, 46630 testnet). */
  tokenChainId: number;
  explorerBase: string;
  /** Wallet chains a write may be signed from. Empty = any (HL user-signed actions use the wallet's own chain). */
  writeChainAllowlist: number[];
  /** Chains a write is always refused from. The fork profile refuses 4663. */
  writeChainDenylist: number[];
  reownProjectId: string | null;
  pinned?: PinsOverride;
  venueHosts?: Partial<Record<VenueId, string>>;
  /** Receipt signer addresses that override the SDK pins (fork profile and tests only). */
  receiptSigners?: Hex[];
  /** Anchor contract address override (fork profile and tests only). */
  anchorAddress?: Hex | null;
  anchorChainId?: number;
  fetch?: typeof fetch;
  now?: () => number;
  keystore?: () => KeyStore;
}

export const LOCAL_API = "http://127.0.0.1:22210/v1";
export const LOCAL_RPC = "http://127.0.0.1:22245";
export const RHC_MAINNET = { chainId: 4663, rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com" } as const;
export const RHC_TESTNET = { chainId: 46630, rpc: "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com" } as const;
/** Chains the fork profile signs writes from: anvil, RHC testnet, Base Sepolia, Arbitrum Sepolia (HL testnet signing). */
export const FORK_WRITE_CHAINS = [31337, 46630, 84532, 421614];

type Env = Record<string, string | boolean | undefined>;

function json<T>(raw: unknown, what: string): T | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

/** The config a build gets from its VITE_* variables. Mainnet writes are never enabled by the fork profile. */
export function configFromEnv(env: Env): AppConfig {
  const profile: Profile = env.VITE_PROFILE === "fork" ? "fork" : "live";
  const dev = env.DEV === true || env.DEV === "true";
  const str = (k: string) => (typeof env[k] === "string" && (env[k] as string).trim() !== "" ? (env[k] as string).trim() : undefined);
  if (profile === "fork") {
    return {
      profile,
      apiBase: str("VITE_API_BASE") ?? LOCAL_API,
      network: str("VITE_NETWORK") === "mainnet" ? "mainnet" : "testnet",
      rpcUrl: str("VITE_RPC_URL") ?? LOCAL_RPC,
      tokenChainId: Number(str("VITE_TOKEN_CHAIN_ID") ?? 31337),
      explorerBase: str("VITE_EXPLORER") ?? RHC_TESTNET.explorer,
      writeChainAllowlist: FORK_WRITE_CHAINS,
      writeChainDenylist: [RHC_MAINNET.chainId],
      reownProjectId: str("VITE_WALLETCONNECT_PROJECT_ID") ?? str("VITE_REOWN_PROJECT_ID") ?? null,
      ...(json<PinsOverride>(env.VITE_PINS, "VITE_PINS") ? { pinned: json<PinsOverride>(env.VITE_PINS, "VITE_PINS") } : {}),
      ...(json<Record<string, string>>(env.VITE_VENUE_HOSTS, "VITE_VENUE_HOSTS") ? { venueHosts: json<Record<string, string>>(env.VITE_VENUE_HOSTS, "VITE_VENUE_HOSTS") } : {}),
      ...(json<Hex[]>(env.VITE_RECEIPT_SIGNERS, "VITE_RECEIPT_SIGNERS") ? { receiptSigners: json<Hex[]>(env.VITE_RECEIPT_SIGNERS, "VITE_RECEIPT_SIGNERS") } : {}),
      ...(str("VITE_ANCHOR") ? { anchorAddress: str("VITE_ANCHOR") as Hex, anchorChainId: Number(str("VITE_ANCHOR_CHAIN_ID") ?? 31337) } : {}),
    };
  }
  const testnet = str("VITE_NETWORK") === "testnet";
  const chain = testnet ? RHC_TESTNET : RHC_MAINNET;
  return {
    profile,
    apiBase: str("VITE_API_BASE") ?? (dev ? LOCAL_API : "https://api.get-capstan.com/v1"),
    network: testnet ? "testnet" : "mainnet",
    rpcUrl: str("VITE_RPC_URL") ?? chain.rpc,
    tokenChainId: chain.chainId,
    explorerBase: chain.explorer,
    writeChainAllowlist: [],
    writeChainDenylist: [],
    reownProjectId: str("VITE_WALLETCONNECT_PROJECT_ID") ?? str("VITE_REOWN_PROJECT_ID") ?? null,
  };
}

export const ConfigContext = createContext<AppConfig>(configFromEnv({}));
export const useConfig = () => useContext(ConfigContext);
