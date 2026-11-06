// Fork deployments (ops/fork): a local anvil fork of Robinhood Chain keeps chain id 4663, but its contracts are a
// throwaway set recorded in a `<chainId>-fork.json` file, never in the committed `<chainId>.json`. When
// CAPSTAN_FORK_DEPLOYMENTS names such a file, every role adds that record to DEPLOYMENTS at boot, so the same lookups
// production uses (anchor, lock, tiers) find the fork contracts. It refuses unless every chain RPC in the environment
// is a loopback URL (the fork itself), and it never replaces a committed record for the same chain.
import { DEPLOYMENTS, type Deployment } from "@capstan/schema";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

/** Env names that point a role at a chain. On a fork stack each must be a loopback URL. */
export const CHAIN_RPC_ENV = ["RHC_RPC_URL", "RHC_TESTNET_RPC_URL", "ANCHOR_RPC_URL", "BASE_RPC_URL", "BASE_SEPOLIA_RPC_URL"] as const;

export class ForkDeploymentError extends Error {
  constructor(message: string) {
    super(`fork deployments: ${message}`);
    this.name = "ForkDeploymentError";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackUrl(raw: string): boolean {
  try {
    return LOOPBACK.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * Add the fork deployment named by CAPSTAN_FORK_DEPLOYMENTS to `into` (DEPLOYMENTS by default). Returns the chain id
 * added, or null when the variable is unset. Throws ForkDeploymentError on any unsafe or malformed input.
 */
export function applyForkDeployments(env: Record<string, string | undefined>, into: Record<number, Deployment> = DEPLOYMENTS): number | null {
  const file = env.CAPSTAN_FORK_DEPLOYMENTS?.trim();
  if (!file) return null;
  if (!/^\d+-fork\.json$/.test(basename(file))) throw new ForkDeploymentError("the file name must be <chainId>-fork.json");
  const remote = CHAIN_RPC_ENV.filter((k) => env[k] && !isLoopbackUrl(env[k]!));
  if (remote.length) throw new ForkDeploymentError(`every chain RPC must be the local fork; not loopback: ${remote.join(", ")}`);
  if (!existsSync(file)) throw new ForkDeploymentError("the file does not exist");
  let d: Deployment;
  try {
    d = JSON.parse(readFileSync(file, "utf8")) as Deployment;
  } catch {
    throw new ForkDeploymentError("the file is not JSON");
  }
  const chainId = Number(d?.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0 || `${chainId}-fork.json` !== basename(file)) throw new ForkDeploymentError("chainId differs from the file name");
  if (!d.contracts || typeof d.contracts !== "object") throw new ForkDeploymentError("no contracts");
  for (const [name, c] of Object.entries(d.contracts)) {
    if (!c || !/^0x[0-9a-fA-F]{40}$/.test(String((c as { address?: string }).address))) throw new ForkDeploymentError(`${name} has no address`);
  }
  const existing = into[chainId];
  if (existing && !(existing as Deployment & { fork?: boolean }).fork) {
    throw new ForkDeploymentError(`chain ${chainId} already has a committed deployment; a fork record never replaces it`);
  }
  into[chainId] = { ...d, fork: true } as Deployment;
  return chainId;
}
