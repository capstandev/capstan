// @capstan/mcp: MCP server (Streamable HTTP, stateless) on MCP_PORT at /mcp. The hosted endpoint's host name is
// config (MCP_ALLOWED_HOSTS, default the local port); tools call the public API at API_BASE_URL.
import { loadConfig, logger, type ConfigFor } from "@capstan/core";
import { initTelemetry, telemetryEnv } from "@capstan/telemetry";
import { httpApiClient, type CapstanApiClient } from "./client";
import { paymentsFromEnv, type McpPaymentOverrides } from "./payments";
import { createMcpApp } from "./server";

export const PACKAGE_NAME = "@capstan/mcp" as const;
export const MCP_VERSION = "1.0.0";
export * from "./client";
export * from "./server";
export * from "./payments";
export * from "./tools";

/**
 * The production MCP app from the environment (the entry below calls exactly this). Paid tools get the x402 gate from
 * paymentsFromEnv; with payments off they answer "payments unavailable" and are never served free.
 */
export async function mcpAppFromEnv(cfg: ConfigFor<"mcp">, env: Record<string, string | undefined>, o: McpPaymentOverrides & { api?: CapstanApiClient } = {}) {
  const hosts = (env.MCP_ALLOWED_HOSTS ?? `127.0.0.1:${cfg.MCP_PORT},localhost:${cfg.MCP_PORT}`).split(",").map((s) => s.trim()).filter(Boolean);
  const origins = (env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const payments = await paymentsFromEnv(cfg, env, o);
  const app = createMcpApp({ api: o.api ?? httpApiClient(cfg.API_BASE_URL), version: MCP_VERSION, allowedHosts: hosts, allowedOrigins: origins, ...(payments ? { payments } : {}) });
  return { app, hosts, paidTools: payments !== undefined };
}

if (import.meta.main) {
  const log = logger("mcp");
  try {
    const cfg = loadConfig("mcp");
    const tel = initTelemetry("mcp", telemetryEnv(process.env));
    const { app, hosts, paidTools } = await mcpAppFromEnv(cfg, process.env);
    Bun.serve({ port: cfg.MCP_PORT, hostname: "127.0.0.1", fetch: tel.serve(app.fetch) });
    log.info("listening", { port: cfg.MCP_PORT, hosts, paidTools });
  } catch (e) {
    log.error("boot failed", { error: (e as Error).message });
    process.exit(1);
  }
}
