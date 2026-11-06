// @capstan/facilitator: self-hosted x402 v2 facilitator (Base USDC, Solana USDC, RHC USDG permit2 + eip3009).
// Boot: shared role config, the EVM hot key from its keystore (or the dev signer on 31337), the Solana sponsor from
// its encrypted keystore (optional), Postgres-backed settle records, a reconciler every 30 s and a float check
// every hour. The hot key holds gas only; payTo is never the hot key.
import { closeDb, createDb, devSigner, keystoreSigner, loadConfig, logger, type ServiceSigner } from "@capstan/core";
import { ADDRESSES } from "@capstan/schema";
import { initTelemetry, telemetryEnv } from "@capstan/telemetry";
import { floatGuard, NETWORKS, railDefs, svmKeystoreSigner, type EvmNetwork, type FloatHolding, type SvmNetwork } from "@capstan/x402";
import { createPublicClient, erc20Abi, http, type Hex } from "viem";
import { createFacilitatorApp } from "./app";
import { buildFacilitator } from "./build";
import { loadFacilitatorEnv, settleArmed } from "./env";
import { pgPaymentStore } from "./store";

export { createFacilitatorApp } from "./app";
export { buildFacilitator, evmProbe, svmProbe } from "./build";
export { createFacilitatorService, broadcastTracker, canonicalJson, paymentKey, ERR } from "./service";
export { memoryPaymentStore, pgPaymentStore } from "./store";
export { loadFacilitatorEnv, settleArmed } from "./env";

export const OPS_ALERT_CHANNEL = "ops.alert";

async function main(): Promise<void> {
  const cfg = loadConfig("facilitator");
  const env = loadFacilitatorEnv();
  const log = logger("facilitator", { level: cfg.LOG_LEVEL });
  const tel = initTelemetry("facilitator", telemetryEnv(process.env)); // traces + /metrics
  const x402Env = cfg.CAPSTAN_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const evmNets: { network: EvmNetwork; rpcUrl: string }[] = [];
  const svmNets: { network: SvmNetwork; rpcUrl: string }[] = [];
  if (x402Env === "mainnet") {
    if (env.BASE_RPC_URL) evmNets.push({ network: NETWORKS.base, rpcUrl: env.BASE_RPC_URL });
    if (env.RHC_RPC_URL) evmNets.push({ network: NETWORKS.rhc, rpcUrl: env.RHC_RPC_URL });
    if (env.SOLANA_RPC_URL) svmNets.push({ network: NETWORKS.solana, rpcUrl: env.SOLANA_RPC_URL });
  } else {
    if (env.BASE_SEPOLIA_RPC_URL) evmNets.push({ network: NETWORKS.baseSepolia, rpcUrl: env.BASE_SEPOLIA_RPC_URL });
    if (env.RHC_TESTNET_RPC_URL) evmNets.push({ network: NETWORKS.rhcTestnet, rpcUrl: env.RHC_TESTNET_RPC_URL });
    if (env.SOLANA_DEVNET_RPC_URL) svmNets.push({ network: NETWORKS.solanaDevnet, rpcUrl: env.SOLANA_DEVNET_RPC_URL });
  }
  const allowedChainIds = evmNets.map((n) => (n.network === NETWORKS.base ? 8453 : n.network === NETWORKS.rhc ? 4663 : n.network === NETWORKS.baseSepolia ? 84532 : 46630));
  const hotKey: ServiceSigner =
    cfg.FACILITATOR_SIGNER === "dev" ? devSigner(cfg.FACILITATOR_CHAIN_ID) : await keystoreSigner(cfg.FACILITATOR_KEYSTORE_PATH!, cfg.FACILITATOR_KEYSTORE_PASSWORD_FILE!, { allowedChainIds });
  const sponsor = env.FACILITATOR_SOL_KEYPAIR ? await svmKeystoreSigner(env.FACILITATOR_SOL_KEYPAIR, env.FACILITATOR_SOL_PASSWORD_FILE!) : null;
  if (env.X402_PAYTO_EVM && env.X402_PAYTO_EVM.toLowerCase() === hotKey.address.toLowerCase()) throw new Error("facilitator: payTo is the hot key (refused)");
  if (sponsor && env.X402_PAYTO_SOL === sponsor.address) throw new Error("facilitator: Solana payTo is the sponsor key (refused)");

  const db = createDb(cfg.DATABASE_URL, { max: 5 });
  const alert = (a: { kind: string }) => log.warn("ops alert", { channel: OPS_ALERT_CHANNEL, ...a });
  const holders = [hotKey.address.toLowerCase(), ...(env.X402_PAYTO_IS_SWEEP && env.X402_PAYTO_EVM ? [env.X402_PAYTO_EVM.toLowerCase()] : [])];
  const defs = railDefs(x402Env);
  const float = floatGuard({
    maxUsd: cfg.FACILITATOR_FLOAT_MAX_USD,
    sweepTo: env.X402_SWEEP_TO ?? "<brand Safe>",
    log,
    alert,
    holdings: async () => {
      const out: FloatHolding[] = [];
      for (const n of evmNets) {
        const client = createPublicClient({ transport: http(n.rpcUrl) });
        const asset = (n.network === defs["base-usdc"].network ? defs["base-usdc"].asset : defs["rhc-usdg-permit2"].asset) as Hex;
        for (const h of holders) {
          const atomic = await client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [h as Hex] });
          out.push({ network: n.network, asset, holder: h, atomic, decimals: 6 });
        }
      }
      return out;
    },
  });
  const { service } = buildFacilitator({
    evm: evmNets.length ? { signer: hotKey, networks: evmNets } : undefined,
    svm: sponsor && svmNets.length ? { signer: sponsor, networks: svmNets } : undefined,
    store: pgPaymentStore(db),
    log,
    alert,
    isArmed: () => settleArmed(),
    float,
    floatHolders: holders,
  });
  const app = createFacilitatorApp(service);
  const server = Bun.serve({ port: cfg.FACILITATOR_PORT, hostname: "127.0.0.1", fetch: tel.serve(app.fetch) });
  const rec = setInterval(() => void service.reconcile().catch((err) => log.warn("reconcile failed", { err })), 30_000);
  const flt = setInterval(() => void float.check().catch(() => undefined), 60 * 60 * 1000);
  void float.check().catch(() => undefined);
  log.info("facilitator up", { port: cfg.FACILITATOR_PORT, env: x402Env, evm: evmNets.map((n) => n.network), svm: svmNets.map((n) => n.network), hotKey: hotKey.address, usdg: ADDRESSES.usdgRhc.address });
  const stop = async () => {
    clearInterval(rec);
    clearInterval(flt);
    server.stop();
    await closeDb(db);
    await tel.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

if (import.meta.main) {
  await main().catch((e) => {
    logger("facilitator").error("boot failed", { error: (e as Error).message });
    process.exit(1);
  });
}
