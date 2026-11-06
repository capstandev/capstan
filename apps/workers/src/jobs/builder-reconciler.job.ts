// builder-reconciler (spec 9): daily at 02:00 UTC, Job Scheduler id `builder-reconciler`, for the previous UTC day.
// Hyperliquid runs wherever the job runs (keyless public reads) once HL_BUILDER_ADDRESS is set. Aster needs the
// builder agent's signed reads and runs only on the VPS (CAPSTAN_RUNNER=vps plus the ASTER_BUILDER_* settings); on
// any other host it is skipped with the reason and the Hyperliquid part still runs.
import { createHlRuntime } from "@capstan/adapter-hyperliquid";
import { asterConfig, asterHttp, egressLabel } from "@capstan/adapter-aster";
import type { JobDef, JobDeps } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { AsterNonce, type DigestSigner } from "@capstan/signer-aster";
import { createGovernor, createMemoryGovernor } from "@capstan/venue-client";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  asterReconEnabled,
  httpCsvFetcher,
  memoryCsvState,
  previousUtcDay,
  reconcileAster,
  reconcileHl,
  redisCsvState,
  RECON_MAX_OWNERS,
  signedAsterBuilderReports,
  type AsterBuilderReports,
  type HlReconDeps,
  type ReconReport,
} from "../reconcile";

export const RECONCILER_SCHEDULE = { pattern: "0 2 * * *" } as const;

export interface ReconcilerOverrides {
  day?: string;
  hl?: HlReconDeps["hl"];
  csv?: HlReconDeps["csv"];
  asterReports?: AsterBuilderReports;
}

export interface ReconcilerResult {
  day: string;
  hyperliquid: ReconReport | { skipped: string };
  aster: ReconReport | { skipped: string };
}

/** Signs a raw digest with the builder agent keystore through Foundry cast (this process never holds the key). */
function castDigestSigner(env: Record<string, string | undefined>): DigestSigner {
  const cast = join(homedir(), ".foundry/bin/cast");
  return async (digest) => {
    const r = Bun.spawnSync([cast, "wallet", "sign", "--no-hash", "--keystore", env.ASTER_BUILDER_AGENT_KEYSTORE!, "--password-file", env.ASTER_BUILDER_AGENT_PASSWORD_FILE!, digest]);
    if (r.exitCode !== 0) throw new Error("cast wallet sign failed for the Aster builder agent");
    return r.stdout.toString().trim() as Hex;
  };
}

export async function runReconciler(deps: JobDeps, env: Record<string, string | undefined> = process.env, o: ReconcilerOverrides = {}): Promise<ReconcilerResult> {
  if (!deps.db) throw new Error("builder-reconciler needs DATABASE_URL");
  const db = deps.db;
  const day = o.day ?? previousUtcDay(deps.now());
  const publish = deps.publish;
  const log = deps.log;
  const maxOwners = Number(env.RECON_MAX_OWNERS ?? RECON_MAX_OWNERS);
  const out: ReconcilerResult = { day, hyperliquid: { skipped: "" }, aster: { skipped: "" } };

  const hlBuilder = env.HL_BUILDER_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(env.HL_BUILDER_ADDRESS) ? (env.HL_BUILDER_ADDRESS.toLowerCase() as Hex) : null;
  if (!hlBuilder) {
    // TODO(owner): the Hyperliquid builder address arrives with the builder wallet (owner step)
    out.hyperliquid = { skipped: "HL_BUILDER_ADDRESS is not set" };
  } else {
    try {
      const hl = o.hl ?? createHlRuntime(env, { redis: deps.redis, cache: deps.cache }).reader;
      out.hyperliquid = await reconcileHl(day, {
        db,
        hl,
        builder: hlBuilder,
        csv: o.csv ?? httpCsvFetcher(),
        csvState: deps.redis ? redisCsvState(deps.redis, hlBuilder) : memoryCsvState(),
        maxOwners: Number.isInteger(maxOwners) && maxOwners > 0 ? maxOwners : RECON_MAX_OWNERS,
        now: deps.now,
        ...(publish ? { publish } : {}),
        log,
      });
    } catch (e) {
      log.error("reconcile hl failed", { day, error: (e as Error).message });
      out.hyperliquid = { skipped: `failed: ${(e as Error).message}` };
    }
  }

  const gate = o.asterReports ? ({ ok: true } as const) : asterReconEnabled(env);
  if (!gate.ok) {
    out.aster = { skipped: gate.reason };
  } else {
    try {
      let reports = o.asterReports;
      if (!reports) {
        const network = env.CAPSTAN_ASTER_NETWORK === "Testnet" ? "Testnet" : "Mainnet";
        const gov = deps.redis ? createGovernor(deps.redis, egressLabel(env)) : createMemoryGovernor(egressLabel(env));
        const nonce = new AsterNonce();
        reports = signedAsterBuilderReports({ http: asterHttp(asterConfig(network), gov, { priority: "free" }), network, builder: env.ASTER_BUILDER_ADDRESS as Hex, agent: env.ASTER_BUILDER_AGENT_ADDRESS as Hex, sign: castDigestSigner(env), nonce: () => nonce.next(BigInt(Date.now()) * 1000n) });
      }
      out.aster = await reconcileAster(day, { db, builderReports: reports, now: deps.now, ...(publish ? { publish } : {}), log });
    } catch (e) {
      log.error("reconcile aster failed", { day, error: (e as Error).message });
      out.aster = { skipped: `failed: ${(e as Error).message}` };
    }
  }
  const summary = (r: ReconReport | { skipped: string }) => ("skipped" in r ? { skipped: r.skipped } : { fills: r.fills, feeUsd: r.feeUsd, unmatched: r.unmatchedFills.length, receiptsWithoutFill: r.receiptsWithoutFill.length, csv: r.csvCrossCheck?.status ?? null });
  log.info("builder-reconciler", { day, hyperliquid: summary(out.hyperliquid), aster: summary(out.aster) });
  return out;
}

export const job: JobDef = {
  name: "builder-reconciler",
  queue: "reconcileDaily",
  schedule: RECONCILER_SCHEDULE,
  concurrency: 1,
  handler: (_job, deps) => runReconciler(deps),
};
