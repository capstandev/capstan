// @capstan/ws: WebSocket gateway: market, account and plan streams.
// Boot only for now: validates the ws role's config and answers GET /health. The service code lands in its own todo.
import { loadConfig, logger } from "@capstan/core";
import { initTelemetry, telemetryEnv } from "@capstan/telemetry";

export const PACKAGE_NAME = "@capstan/ws" as const;

if (import.meta.main) {
  const log = logger("ws");
  try {
    const cfg = loadConfig("ws");
    const tel = initTelemetry("ws", telemetryEnv(process.env)); // traces + /metrics
    Bun.serve({
      port: cfg.WS_PORT,
      hostname: "127.0.0.1",
      fetch: tel.serve((req) => (new URL(req.url).pathname === "/health" ? Response.json({ ok: true, service: "ws" }) : Response.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 }))),
    });
    log.info("listening", { port: cfg.WS_PORT });
  } catch (e) {
    log.error("boot failed", { error: (e as Error).message });
    process.exit(1);
  }
}
