// Facilitator settings beyond the shared role config (@capstan/core loadConfig("facilitator")): RPCs per network,
// payTo addresses, the Solana sponsor keystore and the mainnet arming pair. Every arming flag is off by default.
// The EVM hot key is the shared FACILITATOR_KEYSTORE_PATH / FACILITATOR_KEYSTORE_PASSWORD_FILE pair.
import { existsSync } from "node:fs";
import { z } from "zod";

const flag = z.enum(["0", "1"]).default("0").transform((v) => v === "1");
const url = z.string().url().optional();
const evmAddr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const FacilitatorEnv = z.object({
  CAPSTAN_NETWORK: z.enum(["local", "testnet", "mainnet"]).default("local"),
  BASE_RPC_URL: url,
  BASE_SEPOLIA_RPC_URL: url,
  RHC_RPC_URL: url,
  RHC_TESTNET_RPC_URL: url,
  SOLANA_RPC_URL: url,
  SOLANA_DEVNET_RPC_URL: url,
  FACILITATOR_SOL_KEYPAIR: z.string().min(1).optional(),
  FACILITATOR_SOL_PASSWORD_FILE: z.string().min(1).optional(),
  X402_PAYTO_EVM: evmAddr.optional(),
  X402_PAYTO_SOL: z.string().min(32).max(44).optional(),
  /** Set when payTo is a sweep address (not the Safe): the float guard then watches it. */
  X402_PAYTO_IS_SWEEP: flag,
  X402_SWEEP_TO: z.string().min(1).optional(),
  X402_SETTLE_ARMED: flag,
  X402_SETTLE_ARMED_FILE: z.string().min(1).optional(),
});
export type FacilitatorEnv = z.infer<typeof FacilitatorEnv>;

export function loadFacilitatorEnv(env: Record<string, string | undefined> = process.env): FacilitatorEnv {
  const input: Record<string, string> = {};
  for (const k of Object.keys(FacilitatorEnv.shape)) if (env[k] !== undefined && env[k] !== "") input[k] = env[k]!;
  const r = FacilitatorEnv.safeParse(input);
  if (!r.success) throw new Error(`facilitator env: missing or invalid: ${[...new Set(r.error.issues.map((i) => String(i.path[0])))].sort().join(", ")}`);
  if ((r.data.FACILITATOR_SOL_KEYPAIR === undefined) !== (r.data.FACILITATOR_SOL_PASSWORD_FILE === undefined)) {
    throw new Error("facilitator env: FACILITATOR_SOL_KEYPAIR and FACILITATOR_SOL_PASSWORD_FILE go together");
  }
  return r.data;
}

/**
 * Mainnet settles are armed only when X402_SETTLE_ARMED=1, the file named by X402_SETTLE_ARMED_FILE exists, and
 * CAPSTAN_NETWORK=mainnet. Read on every settle, so removing the file disarms at once.
 */
export function settleArmed(env: Record<string, string | undefined> = process.env): boolean {
  if (env.X402_SETTLE_ARMED !== "1") return false;
  const f = env.X402_SETTLE_ARMED_FILE;
  if (!f || !existsSync(f)) return false;
  return env.CAPSTAN_NETWORK === "mainnet";
}
