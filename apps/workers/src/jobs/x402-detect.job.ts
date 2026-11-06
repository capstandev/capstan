// x402-detect: USDG EIP-3009 detection on RHC 4663 and 46630 every 24 h (read-only eth_call; never version() or
// eip712Domain()). Writes x402_detections; a flip to absent raises an ops alert, and the gate drops the eip3009
// option on its next state refresh. Boot runs call runX402Detect directly (the API does it before serving).
import type { JobDef, JobDeps } from "@capstan/core";
import { runUsdgDetection, type DetectionRun, type ReadClient, type UsdgChain } from "@capstan/x402";
import { createPublicClient, http } from "viem";

export const OPS_ALERT_CHANNEL = "ops.alert";
export const DETECT_EVERY_MS = 24 * 60 * 60 * 1000;

export function rpcsFromEnv(env: Record<string, string | undefined> = process.env): Partial<Record<UsdgChain, ReadClient>> {
  const out: Partial<Record<UsdgChain, ReadClient>> = {};
  if (env.RHC_RPC_URL) out["4663"] = createPublicClient({ transport: http(env.RHC_RPC_URL, { retryCount: 3 }) });
  if (env.RHC_TESTNET_RPC_URL) out["46630"] = createPublicClient({ transport: http(env.RHC_TESTNET_RPC_URL, { retryCount: 3 }) });
  return out;
}

export async function runX402Detect(deps: JobDeps, rpcs: Partial<Record<UsdgChain, ReadClient>> = rpcsFromEnv()): Promise<DetectionRun> {
  if (!deps.db) throw new Error("x402-detect needs a database");
  const run = await runUsdgDetection(deps.db, rpcs, () => deps.now().getTime());
  deps.log.info("x402-detect report", Object.fromEntries(Object.entries(run.results).map(([c, r]) => [c, { supported: r?.supported, reason: r?.reason }])));
  for (const chain of run.flippedToAbsent) {
    const alert = { kind: "x402.eip3009_absent", chain, reason: run.results[chain]?.reason ?? "" };
    if (deps.publish) await deps.publish(OPS_ALERT_CHANNEL, alert);
    else deps.log.warn("ops alert", alert);
  }
  return run;
}

export const job: JobDef = {
  name: "x402-detect",
  queue: "x402Settle",
  schedule: { every: DETECT_EVERY_MS },
  concurrency: 1,
  handler: (_job, deps) => runX402Detect(deps),
};
