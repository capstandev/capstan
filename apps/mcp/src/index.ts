// @capstan/mcp: MCP server (Streamable HTTP, stateless) on MCP_PORT at /mcp. The hosted endpoint's host name is
// config (MCP_ALLOWED_HOSTS, default the local port); tools call the public API at API_BASE_URL.
import { loadConfig, logger } from "@capstan/core";
import { initTelemetry, telemetryEnv } from "@capstan/telemetry";
import { httpApiClient } from "./client";
import { createMcpApp } from "./server";

export const PACKAGE_NAME = "@capstan/mcp" as const;
export const MCP_VERSION = "1.0.0";
export * from "./client";
export * from "./server";
export * from "./tools";

if (import.meta.main) {
  const log = logger("mcp");
  try {
    const cfg = loadConfig("mcp");
    const tel = initTelemetry("mcp", telemetryEnv(process.env));
    const hosts = (process.env.MCP_ALLOWED_HOSTS ?? `127.0.0.1:${cfg.MCP_PORT},localhost:${cfg.MCP_PORT}`).split(",").map((s) => s.trim()).filter(Boolean);
    const origins = (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const app = createMcpApp({ api: httpApiClient(cfg.API_BASE_URL), version: MCP_VERSION, allowedHosts: hosts, allowedOrigins: origins });
    Bun.serve({ port: cfg.MCP_PORT, hostname: "127.0.0.1", fetch: tel.serve(app.fetch) });
    log.info("listening", { port: cfg.MCP_PORT, hosts });
  } catch (e) {
    log.error("boot failed", { error: (e as Error).message });
    process.exit(1);
  }
}
