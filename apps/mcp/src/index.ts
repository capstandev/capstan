// @capstan/mcp: MCP server (Streamable HTTP, stateless) on MCP_PORT at /mcp. The hosted endpoint's host name is
// config (MCP_ALLOWED_HOSTS, default the local port); tools call the public API at API_BASE_URL.
import { createDb, healthProbe, loadConfig, logger, releaseVersion, type ConfigFor } from "@capstan/core";
import { bufferedRequestLog, dailyClientHasher, initTelemetry, telemetryEnv } from "@capstan/telemetry";
import { httpApiClient, type CapstanApiClient } from "./client";
import { paymentsFromEnv, type McpPaymentOverrides } from "./payments";
import { createMcpApp, type McpAppDeps } from "./server";

export const PACKAGE_NAME = "@capstan/mcp" as const;
export const MCP_VERSION = "1.0.0";
export * from "./client";
export * from "./server";
export * from "./payments";
export * from "./tools";

/** The MCP tools need the API: its /health must answer 200 (one probe per 5 s at most, through healthProbe). */
export function apiHealthCheck(apiBase: string, f: typeof fetch = fetch): () => Promise<void> {
  const url = `${apiBase.replace(/\/+$/, "")}/health`;
  return async () => {
    const r = await f(url, { headers: { accept: "application/json" } });
    await r.body?.cancel();
    if (r.status !== 200) throw new Error(`api health ${r.status}`);
  };
}

/**
 * The production MCP app from the environment (the entry below calls exactly this). Paid tools get the x402 gate from
 * paymentsFromEnv; with payments off they answer "payments unavailable" and are never served free.
 */
export async function mcpAppFromEnv(cfg: ConfigFor<"mcp">, env: Record<string, string | undefined>, o: McpPaymentOverrides & { api?: CapstanApiClient; requestLog?: McpAppDeps["requestLog"]; health?: McpAppDeps["health"] } = {}) {
  // r1:9 F-3: behind Caddy the Host is the public api host, so a hosted server with only the loopback default answers
  // 403 to every /mcp request while its loopback health probe stays green. Refuse to start instead.
  if (!env.MCP_ALLOWED_HOSTS?.trim() && (cfg.CAPSTAN_NETWORK === "testnet" || cfg.CAPSTAN_NETWORK === "mainnet")) {
    throw new Error(`MCP_ALLOWED_HOSTS is required on ${cfg.CAPSTAN_NETWORK} (the public api host, for example api.<domain>)`);
  }
  const hosts = (env.MCP_ALLOWED_HOSTS?.trim() || `127.0.0.1:${cfg.MCP_PORT},localhost:${cfg.MCP_PORT}`).split(",").map((s) => s.trim()).filter(Boolean);
  const origins = (env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const payments = await paymentsFromEnv(cfg, env, o);
  const health = o.health ?? { version: releaseVersion(env), probe: healthProbe({ api: apiHealthCheck(cfg.API_BASE_URL) }) };
  const app = createMcpApp({ api: o.api ?? httpApiClient(cfg.API_BASE_URL), version: MCP_VERSION, health, allowedHosts: hosts, allowedOrigins: origins, ...(payments ? { payments } : {}), ...(o.requestLog ? { requestLog: o.requestLog } : {}), rateLimit: { perMin: cfg.MCP_RATE_LIMIT_PER_MIN } });
  return { app, hosts, paidTools: payments !== undefined };
}

if (import.meta.main) {
  const log = logger("mcp");
  try {
    const cfg = loadConfig("mcp");
    const tel = initTelemetry("mcp", telemetryEnv(process.env));
    const sink = cfg.DATABASE_URL ? bufferedRequestLog(createDb(cfg.DATABASE_URL, { max: 2 }), { onError: (e, dropped) => log.warn("request log insert failed", { error: e.message, dropped }) }) : null;
    const { app, hosts, paidTools } = await mcpAppFromEnv(cfg, process.env, sink ? { requestLog: { sink, hash: dailyClientHasher() } } : {});
    const server = Bun.serve({ port: cfg.MCP_PORT, hostname: "127.0.0.1", fetch: tel.serve(app.fetch) });
    log.info("listening", { port: cfg.MCP_PORT, hosts, paidTools, requestLog: !!sink });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      setTimeout(() => process.exit(1), 3_000).unref();
      await server.stop();
      await sink?.close();
      await tel.shutdown();
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (e) {
    log.error("boot failed", { error: (e as Error).message });
    process.exit(1);
  }
}
