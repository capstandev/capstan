// @capstan/facilitator: Self-hosted x402 facilitator (Base, Solana, RHC).
// Boot only for now: validates the facilitator role's config and answers GET /health. The service code lands in its own todo.
import { loadConfig, logger } from "@capstan/core";
import { initTelemetry, telemetryEnv } from "@capstan/telemetry";

export const PACKAGE_NAME = "@capstan/facilitator" as const;

if (import.meta.main) {
  const log = logger("facilitator");
  try {
    const cfg = loadConfig("facilitator");
    const tel = initTelemetry("facilitator", telemetryEnv(process.env)); // traces + /metrics
    Bun.serve({
      port: cfg.FACILITATOR_PORT,
      hostname: "127.0.0.1",
      fetch: tel.serve((req) => (new URL(req.url).pathname === "/health" ? Response.json({ ok: true, service: "facilitator" }) : Response.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 }))),
    });
    log.info("listening", { port: cfg.FACILITATOR_PORT });
  } catch (e) {
    log.error("boot failed", { error: (e as Error).message });
    process.exit(1);
  }
}
