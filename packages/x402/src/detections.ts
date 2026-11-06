// USDG EIP-3009 detection results in x402_detections: written at boot and every 24 h by the x402-detect job, read by
// the gate. A missing, failed or stale (older than 25 h) row reads as absent, so the eip3009 option is removed.
import { schema, type Db } from "@capstan/core";
import { ADDRESSES, type Hex } from "@capstan/schema";
import { and, eq } from "drizzle-orm";
import { detectEip3009, type DetectionResult, type ReadClient } from "./detect";
import { NETWORKS } from "./networks";

export const DETECTION_VALIDITY_MS = 25 * 60 * 60 * 1000; // 24 h cadence plus an hour of slack
export const USDG_TARGETS = {
  "4663": { network: NETWORKS.rhc, token: ADDRESSES.usdgRhc.address as Hex, chainId: 4663 },
  "46630": { network: NETWORKS.rhcTestnet, token: ADDRESSES.usdgRhcTestnet.address as Hex, chainId: 46630 },
} as const;
export type UsdgChain = keyof typeof USDG_TARGETS;

export async function recordDetection(db: Db, chain: string, asset: string, result: DetectionResult): Promise<void> {
  const t = schema.x402Detections;
  const row = { chain, asset: asset.toLowerCase(), method: "eip3009", supported: result.supported, details: { reason: result.reason }, checkedAt: new Date(result.checkedAt) };
  await db
    .insert(t)
    .values(row)
    .onConflictDoUpdate({ target: [t.chain, t.asset, t.method], set: { supported: row.supported, details: row.details, checkedAt: row.checkedAt } });
}

export async function loadUsdgEip3009(db: Db, nowMs: number = Date.now()): Promise<Record<UsdgChain, boolean>> {
  const out: Record<UsdgChain, boolean> = { "4663": false, "46630": false };
  const t = schema.x402Detections;
  for (const chain of Object.keys(USDG_TARGETS) as UsdgChain[]) {
    const tgt = USDG_TARGETS[chain];
    const rows = await db
      .select()
      .from(t)
      .where(and(eq(t.chain, tgt.network), eq(t.asset, tgt.token.toLowerCase()), eq(t.method, "eip3009")));
    const r = rows[0];
    out[chain] = !!r && r.supported && nowMs - r.checkedAt.getTime() <= DETECTION_VALIDITY_MS;
  }
  return out;
}

export interface DetectionRun {
  results: Partial<Record<UsdgChain, DetectionResult>>;
  /** Chains that flipped from supported to absent in this run (ops alert). */
  flippedToAbsent: UsdgChain[];
}

/** Run detection on every chain with an RPC, record it, and report flips. A chain without an RPC is recorded absent. */
export async function runUsdgDetection(db: Db, rpcs: Partial<Record<UsdgChain, ReadClient>>, now: () => number = Date.now): Promise<DetectionRun> {
  const before = await loadUsdgEip3009(db, now());
  const run: DetectionRun = { results: {}, flippedToAbsent: [] };
  for (const chain of Object.keys(USDG_TARGETS) as UsdgChain[]) {
    const tgt = USDG_TARGETS[chain];
    const rpc = rpcs[chain];
    const res = rpc
      ? await detectEip3009(rpc, tgt.token, { name: "Global Dollar", version: "1", chainId: tgt.chainId }, now)
      : { supported: false, reason: "no rpc configured", checkedAt: now() };
    await recordDetection(db, tgt.network, tgt.token, res);
    run.results[chain] = res;
    if (before[chain] && !res.supported) run.flippedToAbsent.push(chain);
  }
  return run;
}
