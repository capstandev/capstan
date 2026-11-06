// x402 over MCP for the production host (todo 32): the resource server, the accepts per paid tool and the internal
// caller token, built from the environment. Off unless X402_ENABLED=1 AND both payTo addresses AND a
// CAPSTAN_INTERNAL_TOKEN of 32+ characters are set: without them a paid tool answers "payments unavailable" (never
// served free). Accepts come from the same rail state the api uses (packages/x402 railStateLoader): token facts read
// once, the USDG EIP-3009 detection flags re-read every minute from x402_detections when DATABASE_URL is set (the api
// and the workers job write them); without a database the eip3009 option is never offered (fail closed).
import { createDb, logger, type ConfigFor } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { acceptsFor, bootClientsFromEnv, createResourceServer, loadUsdgEip3009, railStateLoader, type BootClient, type EvmNetwork } from "@capstan/x402";
import type { FacilitatorClient } from "@x402/core/server";
import type { McpPayments } from "./server";

export const MIN_INTERNAL_TOKEN = 32;

export interface McpPaymentOverrides {
  facilitator?: FacilitatorClient;
  clients?: Partial<Record<EvmNetwork, BootClient>>;
  /** Detection flags source (default: x402_detections through DATABASE_URL, else absent). */
  detections?: () => Promise<{ "4663": boolean; "46630": boolean }>;
  log?: { info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void };
}

/** Why payments are off on this host, or null when they are on. Names only, never a value. */
export function paymentsOffReason(cfg: ConfigFor<"mcp">, env: Record<string, string | undefined>): string | null {
  if (!cfg.X402_ENABLED) return "X402_ENABLED is off";
  if (!env.X402_PAY_TO_EVM || !env.X402_PAY_TO_SOL) return "X402_PAY_TO_EVM and X402_PAY_TO_SOL are required";
  if (!env.CAPSTAN_INTERNAL_TOKEN || env.CAPSTAN_INTERNAL_TOKEN.length < MIN_INTERNAL_TOKEN) return `CAPSTAN_INTERNAL_TOKEN (${MIN_INTERNAL_TOKEN}+ characters) is required`;
  return null;
}

export async function paymentsFromEnv(cfg: ConfigFor<"mcp">, env: Record<string, string | undefined>, o: McpPaymentOverrides = {}): Promise<McpPayments | undefined> {
  const log = o.log ?? logger("mcp");
  const off = paymentsOffReason(cfg, env);
  if (off) {
    log.info("paid tools off", { reason: off });
    return undefined;
  }
  const net: "mainnet" | "testnet" = cfg.CAPSTAN_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const clients = o.clients ?? (await bootClientsFromEnv(net, env)).clients;
  let detections = o.detections;
  if (!detections) {
    const db = env.DATABASE_URL ? createDb(env.DATABASE_URL, { max: 2 }) : null;
    detections = db ? () => loadUsdgEip3009(db) : async () => ({ "4663": false, "46630": false });
  }
  const rails = railStateLoader({
    env: net,
    routes: { "capstan_spread_scan": { usd: "0.02", description: "spread scan" }, "capstan_risk": { usd: "0.01", description: "risk for third-party addresses" } },
    clients,
    payTo: { evm: env.X402_PAY_TO_EVM as Hex, sol: env.X402_PAY_TO_SOL! },
    detections,
    eip3009MainnetEnabled: cfg.X402_USDG_EIP3009_MAINNET,
    alert: (a) => log.warn("x402 rail alert", a),
  });
  const { HTTPFacilitatorClient } = await import("@x402/core/server");
  const resourceServer = createResourceServer(o.facilitator ?? new HTTPFacilitatorClient({ url: cfg.FACILITATOR_URL }));
  // the facilitator's /supported is read before the first paid call; a failure is retried on the next call
  let ready: Promise<void> | null = null;
  return {
    resourceServer,
    internalToken: env.CAPSTAN_INTERNAL_TOKEN!,
    async accepts(tool) {
      ready ??= resourceServer.initialize().catch((err) => {
        ready = null;
        throw err;
      });
      await ready;
      return acceptsFor({ usd: tool.priced!.usd, description: tool.name }, await rails.load(), net);
    },
  };
}
