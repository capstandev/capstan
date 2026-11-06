// @capstan/mcp: MCP server (Streamable HTTP).
// Boot only for now: validates the mcp role's config and answers GET /health. The service code lands in its own todo.
import { loadConfig, logger } from "@capstan/core";
import { initTelemetry, telemetryEnv } from "@capstan/telemetry";

export const PACKAGE_NAME = "@capstan/mcp" as const;

if (import.meta.main) {
  const log = logger("mcp");
  try {
    const cfg = loadConfig("mcp");
    const tel = initTelemetry("mcp", telemetryEnv(process.env)); // traces + /metrics
    Bun.serve({
      port: cfg.MCP_PORT,
      hostname: "127.0.0.1",
      fetch: tel.serve((req) => (new URL(req.url).pathname === "/health" ? Response.json({ ok: true, service: "mcp" }) : Response.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 }))),
    });
    log.info("listening", { port: cfg.MCP_PORT });
  } catch (e) {
    log.error("boot failed", { error: (e as Error).message });
    process.exit(1);
  }
}
