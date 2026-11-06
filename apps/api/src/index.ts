// @capstan/api entry. `bun apps/api/src/index.ts` validates config for the api role and serves on API_PORT.
import { loadConfig, logger } from "@capstan/core";
import { initTelemetry, telemetryEnv } from "@capstan/telemetry";
import { createApp } from "./app";

export { createApp };

if (import.meta.main) {
  const log = logger("api");
  try {
    const cfg = loadConfig("api");
    const tel = initTelemetry("api", telemetryEnv(process.env)); // traces + /metrics
    const { app, routes } = await createApp();
    Bun.serve({ port: cfg.API_PORT, hostname: "127.0.0.1", fetch: tel.serve(app.fetch) });
    log.info("listening", { port: cfg.API_PORT, routes: routes.length });
  } catch (e) {
    log.error("boot failed", { error: (e as Error).message });
    process.exit(1);
  }
}
