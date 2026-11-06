// Shared fixtures for the onboarding and order tests: a reader on recorded data, an executable market, a real
// WASM signer and hasher, and a test owner wallet derived from a public seed string (never a real key).
import { createLighterHasher, createLighterSigner, type LighterHasher, type LighterSigner } from "@capstan/signer-lighter-wasm";
import type { BuildContext, Hex, OrderBook, VenueIdentity } from "@capstan/schema";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LIGHTER_CONFIGS, type LighterConfig, type LighterMarketMeta, type LighterReader } from "../src";
import { fakeLighter, readerFor, type FxVenue } from "./helpers";

/** Test wallet from a public seed phrase string. Not a real key: test only. */
export const ownerWallet = privateKeyToAccount(keccak256(toBytes("capstan lighter adapter test owner"))); // test-key
export const otherWallet = privateKeyToAccount(keccak256(toBytes("capstan lighter adapter other wallet"))); // test-key

export const NOW = 1_793_934_000_000;

export function identity(cfg: Readonly<LighterConfig>, accountIndex = 99, apiKeyIndex = 4): VenueIdentity {
  return { venue: cfg.venue, owner: ownerWallet.address as Hex, accountIndex, apiKeyIndex };
}

export function buildCtx(cfg: Readonly<LighterConfig>, id = identity(cfg)): BuildContext {
  return { owner: id.owner, agentRef: `${cfg.venue}:${id.accountIndex}:${id.apiKeyIndex}`, identity: id, builderFee: null, approvedMaxBps: null, nowMs: NOW, eligibilityDecisionId: "elig-test", policyId: null };
}

export async function setup(name: "mainnet" | "rh" = "mainnet") {
  const cfg = LIGHTER_CONFIGS[name];
  const v: FxVenue = name === "rh" ? "lighter-466324" : "lighter-304";
  const srv = fakeLighter(v);
  const reader: LighterReader = readerFor(cfg, srv.url);
  const markets = await reader.listMarkets();
  const meta = async (symbol: string): Promise<LighterMarketMeta> => {
    const m = markets.find((x) => x.venueSymbol === symbol)!;
    const mm = await reader.marketMeta(m.id);
    return { ...mm, market: { ...mm.market, executable: true } };
  };
  return { cfg, srv, reader, markets, meta };
}

let shared: { signer: Map<number, LighterSigner>; hasher: Map<number, LighterHasher> } | null = null;

export async function wasm(chainId: 304 | 466324 | 300) {
  shared ??= { signer: new Map(), hasher: new Map() };
  if (!shared.signer.has(chainId)) {
    const s = await createLighterSigner(chainId);
    s.generateApiKey();
    shared.signer.set(chainId, s);
    shared.hasher.set(chainId, await createLighterHasher(chainId));
  }
  return { signer: shared.signer.get(chainId)!, hasher: shared.hasher.get(chainId)! };
}

export function closeWasm(): void {
  for (const s of shared?.signer.values() ?? []) s.close();
  for (const h of shared?.hasher.values() ?? []) h.close();
  shared = null;
}

export const STD_FEE = { makerBps: 0, takerBps: 0, makerLatencyMs: 0, takerLatencyMs: 300, tier: "standard" as const };

export function bookFromLevels(marketId: string, asks: [string, string][], bids: [string, string][]): OrderBook {
  return { marketId, asks, bids, asOf: new Date(NOW).toISOString() };
}
