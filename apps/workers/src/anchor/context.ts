// Builds the anchor and receipt contexts from the workers config (todo 28). Service keys load only from a keystore
// file plus a password file (or, on the local chain 31337 only, the dev signer); a raw key variable makes loadConfig
// refuse to start. The anchor job also refuses to start unless the poster key equals the contract's poster().
import { createDb, devSigner, keystoreSigner, loadConfig, type ConfigFor, type JobDeps, type ServiceSigner } from "@capstan/core";
import { DEPLOYMENTS, type Hex } from "@capstan/schema";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import { assertPosterMatches, type AnchorDeps } from "./anchor";
import { NonceManager } from "./nonce";

type WorkersConfig = ConfigFor<"workers">;

/** Load a service signer by prefix (ANCHOR or RECEIPT) from the workers config. */
export async function loadServiceSigner(cfg: WorkersConfig, prefix: "ANCHOR" | "RECEIPT"): Promise<ServiceSigner> {
  const kind = prefix === "ANCHOR" ? cfg.ANCHOR_SIGNER : cfg.RECEIPT_SIGNER;
  const chainId = prefix === "ANCHOR" ? cfg.ANCHOR_CHAIN_ID : cfg.RECEIPT_CHAIN_ID;
  if (kind === "none") throw new Error(`${prefix}_SIGNER is none: this worker does not hold a ${prefix.toLowerCase()} key`);
  if (kind === "dev") return devSigner(chainId, `capstan-${prefix.toLowerCase()}-dev`);
  const path = prefix === "ANCHOR" ? cfg.ANCHOR_KEYSTORE_PATH : cfg.RECEIPT_KEYSTORE_PATH;
  const pw = prefix === "ANCHOR" ? cfg.ANCHOR_KEYSTORE_PASSWORD_FILE : cfg.RECEIPT_KEYSTORE_PASSWORD_FILE;
  return keystoreSigner(path!, pw!, { allowedChainIds: [chainId] });
}

const LOCAL_DEPLOYMENT = join(import.meta.dir, "../../../../contracts/deployments/local/31337.json");

/** The anchor address and deployment block for a chain: the generated deployment copy, or the local file on 31337. */
export function anchorDeployment(chainId: number): { address: Hex; block: bigint } {
  const d = DEPLOYMENTS[chainId]?.contracts.CapstanReceiptAnchor;
  if (d) return { address: d.address as Hex, block: BigInt(d.block ?? 0) };
  if (chainId === 31337 && existsSync(LOCAL_DEPLOYMENT)) {
    const j = JSON.parse(readFileSync(LOCAL_DEPLOYMENT, "utf8")) as { contracts: { CapstanReceiptAnchor?: { address: Hex; block?: number } } };
    if (j.contracts.CapstanReceiptAnchor) return { address: j.contracts.CapstanReceiptAnchor.address, block: BigInt(j.contracts.CapstanReceiptAnchor.block ?? 0) };
  }
  throw new Error(`no CapstanReceiptAnchor deployment for chain ${chainId}`);
}

export interface AnchorContext extends AnchorDeps {
  rpc: PublicClient;
  deploymentBlock: bigint;
}

/** Everything the anchor jobs need; refuses unless the poster key is the contract's poster. Resyncs the nonce. */
export async function buildAnchorContext(deps: JobDeps, env: Record<string, string | undefined> = process.env): Promise<AnchorContext> {
  const cfg = loadConfig("workers", env);
  const db = deps.db ?? createDb(cfg.DATABASE_URL);
  const signer = await loadServiceSigner(cfg, "ANCHOR");
  const rpc = createPublicClient({ transport: http(cfg.ANCHOR_RPC_URL) }) as PublicClient;
  const dep = anchorDeployment(cfg.ANCHOR_CHAIN_ID);
  await assertPosterMatches(rpc, dep.address, signer.address);
  const nonces = new NonceManager(db, rpc, "anchor-poster", signer.address, cfg.ANCHOR_CHAIN_ID);
  await nonces.resync();
  return {
    db,
    rpc,
    signer,
    anchor: dep.address,
    deploymentBlock: dep.block,
    chainId: cfg.ANCHOR_CHAIN_ID,
    nonces,
    log: deps.log,
    now: deps.now,
    publish: deps.publish,
    armed: cfg.ANCHOR_ARMED,
    armedFile: cfg.ANCHOR_ARMED_FILE,
    minBalanceWei: BigInt(cfg.ANCHOR_MIN_BALANCE_WEI),
  };
}
