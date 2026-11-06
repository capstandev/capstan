// Boot-time x402 state for the API gate: token facts read from chain (decimals and EIP-712 domain), the REL-3 rail
// economics (fork-measured gas x live gas price x ETH/USD from the RHC Chainlink feed), and the detection flags.
// Every failure fails closed: a rail without token facts or without a cost is left out, with an ops alert.
import { ADDRESSES, type Hex } from "@capstan/schema";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { railEconomics, SETTLE_GAS, SOLANA_SETTLE_LAMPORTS, type PricedRoute, type RailCostInput, type RailEconomics, type X402State } from "./accepts";
import type { ReadClient } from "./detect";
import { EVM_CHAIN_IDS, railDefs, type EvmNetwork, type RailId, type X402Env } from "./networks";
import { readTokenInfo, type TokenInfo } from "./tokens";

export type BootClient = ReadClient & { getGasPrice(): Promise<bigint> };

const FEED_ABI = parseAbi(["function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"]);
/** Chainlink ETH/USD on RHC has a 24 h heartbeat (chain-facts section 5); older than 25 h = stale. */
export const FEED_MAX_AGE_S = 25 * 60 * 60;

/** ETH/USD from the RHC Chainlink proxy (8 decimals). Null when stale, non-positive or unreadable (fail closed). */
export async function readEthUsd(rhc: ReadClient, nowS: number, feed: Hex = ADDRESSES.chainlinkEthUsd.address as Hex): Promise<number | null> {
  try {
    const r = await rhc.call({ to: feed, data: encodeFunctionData({ abi: FEED_ABI, functionName: "latestRoundData" }) });
    if (!r.data) return null;
    const [, answer, , updatedAt] = decodeFunctionResult({ abi: FEED_ABI, functionName: "latestRoundData", data: r.data }) as readonly [bigint, bigint, bigint, bigint, bigint];
    if (answer <= 0n || nowS - Number(updatedAt) > FEED_MAX_AGE_S || Number(updatedAt) > nowS + 300) return null;
    return Number(answer) / 1e8;
  } catch {
    return null;
  }
}

export interface BootInputs {
  env: X402Env;
  routes: Record<string, PricedRoute>;
  clients: Partial<Record<EvmNetwork, BootClient>>;
  usdgEip3009: X402State["usdgEip3009"];
  payTo: X402State["payTo"];
  solFeePayer?: string;
  hotKeys?: string[];
  /** Conservative SOL/USD ceiling used for the Solana settle cost (no free SOL feed on RHC). */
  solUsdCeiling?: number;
  nowS?: number;
  alert?: (a: { kind: string; [k: string]: unknown }) => void | Promise<void>;
}

export async function buildX402State(i: BootInputs): Promise<{ state: X402State; economics: RailEconomics }> {
  const defs = railDefs(i.env);
  const alert = i.alert ?? (() => {});
  const nowS = i.nowS ?? Math.floor(Date.now() / 1000);
  const tokens: Partial<Record<RailId, TokenInfo>> = {};
  const baseNet = defs["base-usdc"].network as EvmNetwork;
  const rhcNet = defs["rhc-usdg-permit2"].network as EvmNetwork;
  const base = i.clients[baseNet];
  const rhc = i.clients[rhcNet];
  if (base) {
    try {
      tokens["base-usdc"] = await readTokenInfo(base, defs["base-usdc"].asset as Hex, EVM_CHAIN_IDS[baseNet], { expectName: defs["base-usdc"].domain!.name });
    } catch (err) {
      await alert({ kind: "x402.token_facts_failed", rail: "base-usdc", reason: String((err as Error).message) });
    }
  }
  if (rhc) {
    try {
      const info = await readTokenInfo(rhc, defs["rhc-usdg-permit2"].asset as Hex, EVM_CHAIN_IDS[rhcNet], { hardVersion: "1", expectName: "Global Dollar" });
      tokens["rhc-usdg-permit2"] = info;
      tokens["rhc-usdg-eip3009"] = info;
    } catch (err) {
      await alert({ kind: "x402.token_facts_failed", rail: "rhc-usdg", reason: String((err as Error).message) });
    }
  }
  // ETH/USD always comes from the mainnet RHC feed client when present (testnet feeds are not maintained)
  const feedClient = i.clients["eip155:4663"] ?? rhc;
  const ethUsd = feedClient ? await readEthUsd(feedClient, nowS) : null;
  const costs: Partial<Record<RailId, RailCostInput>> = {};
  const gas = async (c: BootClient | undefined) => {
    try {
      return c ? await c.getGasPrice() : undefined;
    } catch {
      return undefined;
    }
  };
  const bg = await gas(base);
  const rg = await gas(rhc);
  if (bg !== undefined && ethUsd !== null) costs["base-usdc"] = { gasUnits: SETTLE_GAS["base-usdc"], gasPriceWei: bg, nativeUsd: ethUsd };
  if (rg !== undefined && ethUsd !== null) {
    costs["rhc-usdg-permit2"] = { gasUnits: SETTLE_GAS["rhc-usdg-permit2"], gasPriceWei: rg, nativeUsd: ethUsd };
    costs["rhc-usdg-eip3009"] = { gasUnits: SETTLE_GAS["rhc-usdg-eip3009"], gasPriceWei: rg, nativeUsd: ethUsd };
  }
  if (i.solFeePayer) costs["solana-usdc"] = { usd: (Number(SOLANA_SETTLE_LAMPORTS) / 1e9) * (i.solUsdCeiling ?? 500) };
  const economics = railEconomics(i.routes, costs);
  for (const a of economics.alerts) await alert(a);
  return {
    state: { usdgEip3009: i.usdgEip3009, payTo: i.payTo, tokens, droppedRails: economics.dropped, solFeePayer: i.solFeePayer, hotKeys: i.hotKeys },
    economics,
  };
}
