// Raw Hyperliquid info shapes (venue-hyperliquid.md sections 2 to 4) and the pure helpers that read them: dex list,
// collateral per dex, asset ids. Nothing here does I/O.
import type { Hex } from "@capstan/schema";

export interface HlUniverseEntry {
  name: string; // "BTC" (core) or "xyz:TSLA" (HIP-3)
  szDecimals: number;
  maxLeverage: number;
  marginTableId?: number;
  onlyIsolated?: boolean;
  marginMode?: "strictIsolated" | "noCross" | string;
  isDelisted?: boolean;
  growthMode?: "enabled" | string;
  deployerFeeScale?: string;
  lastFeeScaleChangeTime?: string;
}

export interface HlMeta {
  universe: HlUniverseEntry[];
  marginTables?: unknown;
  collateralToken: number;
}

export interface HlAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs: string[] | null;
  dayBaseVlm: string;
}

export type HlMetaAndAssetCtxs = [HlMeta, HlAssetCtx[]];

export interface HlPerpDexRaw {
  name: string;
  fullName: string;
  deployer: Hex | null;
  oracleUpdater: Hex | null;
  feeRecipient: Hex | null;
  assetToStreamingOiCap?: [string, string][];
  subDeployers?: unknown;
  assetToFundingMultiplier?: [string, string][];
  assetToFundingInterestRate?: [string, string][];
  assetToFundingClamp?: [string, string][];
}

/** One perp dex. Index 0 is the core dex (`name` null); HIP-3 dexes keep their raw `perpDexs` position. */
export interface HlDex {
  index: number;
  name: string | null;
  fullName: string;
  deployer: Hex | null;
  oracleUpdater: Hex | null;
  fundingClamp: Record<string, string>;
  fundingMultiplier: Record<string, string>;
  streamingOiCap: Record<string, string>;
}

/** collateralToken id -> asset (live 2026-11-05). Unknown ids become `TOKEN:<id>` and the market is never executable. */
export const COLLATERAL_TOKENS: Readonly<Record<number, string>> = { 0: "USDC", 360: "USDH", 235: "USDE", 268: "USDT0" };
export const HL_COLLATERAL = ["USDC", "USDH", "USDE", "USDT0"] as const;

export function collateralFor(token: number): { asset: string; known: boolean } {
  const a = COLLATERAL_TOKENS[token];
  return a ? { asset: a, known: true } : { asset: `TOKEN:${token}`, known: false };
}

export function pairsToRecord(pairs: [string, string][] | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs ?? []) if (Array.isArray(p) && typeof p[0] === "string") out[p[0]] = String(p[1]);
  return out;
}

/** perpDexs: index 0 is null (core). Raw order is kept; the index is the dex index of the asset-id formula. */
export function parsePerpDexs(raw: (HlPerpDexRaw | null)[]): HlDex[] {
  if (!Array.isArray(raw)) throw new Error("hyperliquid: perpDexs is not an array");
  return raw.map((d, index) =>
    d === null
      ? { index, name: null, fullName: "Hyperliquid", deployer: null, oracleUpdater: null, fundingClamp: {}, fundingMultiplier: {}, streamingOiCap: {} }
      : {
          index,
          name: d.name,
          fullName: d.fullName,
          deployer: d.deployer ?? null,
          oracleUpdater: d.oracleUpdater ?? null,
          fundingClamp: pairsToRecord(d.assetToFundingClamp),
          fundingMultiplier: pairsToRecord(d.assetToFundingMultiplier),
          streamingOiCap: pairsToRecord(d.assetToStreamingOiCap),
        },
  );
}

export const HIP3_ASSET_BASE = 100_000;
export const HIP3_DEX_STRIDE = 10_000;

/** Core: indexInMeta. HIP-3: 100000 + dexIndex * 10000 + indexInMeta (delisted entries counted). */
export function assetId(dexIndex: number, indexInMeta: number): number {
  if (!Number.isInteger(dexIndex) || dexIndex < 0 || !Number.isInteger(indexInMeta) || indexInMeta < 0) throw new Error("hyperliquid: bad asset index");
  if (dexIndex === 0) return indexInMeta;
  if (indexInMeta >= HIP3_DEX_STRIDE) throw new Error("hyperliquid: HIP-3 index out of range");
  return HIP3_ASSET_BASE + dexIndex * HIP3_DEX_STRIDE + indexInMeta;
}

/** Split `hyperliquid:<dex|->:<symbol>` into dex and the venue coin name ("BTC" or "xyz:TSLA"). */
export function parseMarketId(id: string): { dex: string | null; coin: string } {
  const m = /^hyperliquid:([^:]+):(.+)$/.exec(id);
  if (!m) throw new Error(`hyperliquid: not a hyperliquid market id: ${id}`);
  const dex = m[1] === "-" ? null : m[1]!;
  return { dex, coin: dex === null ? m[2]! : `${dex}:${m[2]}` };
}
