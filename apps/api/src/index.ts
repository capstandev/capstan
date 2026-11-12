// @capstan/api entry. `bun apps/api/src/index.ts` validates config for the api role and serves on API_PORT.
import { createDb, loadConfig, logger, type ConfigFor } from "@capstan/core";
import { clientIp, fileGeo, GEO_FILE } from "@capstan/eligibility";
import { bufferedRequestLog, dailyClientHasher, initTelemetry, telemetryEnv, type RequestLogSink } from "@capstan/telemetry";
import { join } from "node:path";
import { createApp, discoverRoutes, envEdge } from "./app";
import { gatewayFromEnv } from "./auth/env";
import { requestLogger } from "./request-log";
import { SERVER_IDLE_TIMEOUT_S } from "@capstan/schema";

export { createApp };

/** The request log for the api process: buffered rows in request_logs, country from the shared geo file. */
export function requestLogFromConfig(cfg: ConfigFor<"api">, log: ReturnType<typeof logger>): { sink: RequestLogSink; middleware: ReturnType<typeof requestLogger> } {
  const sink = bufferedRequestLog(createDb(cfg.DATABASE_URL, { max: 2 }), { onError: (e, dropped) => log.warn("request log insert failed", { error: e.message, dropped }) });
  const geo = fileGeo(join(cfg.CAPSTAN_GEO_DIR, GEO_FILE));
  const middleware = requestLogger({ sink, hash: dailyClientHasher(), ipOf: (c) => clientIp(c, cfg.CAPSTAN_TRUST_FORWARDED_FOR), country: (ip) => geo.country(ip) });
  return { sink, middleware };
}

if (import.meta.main) {
  const log = logger("api");
  try {
    const cfg = loadConfig("api");
    const tel = initTelemetry("api", telemetryEnv(process.env)); // traces + /metrics
    const specs = (await discoverRoutes()).map((r) => r.spec);
    const gw = await gatewayFromEnv(cfg, process.env, specs);
    const rl = requestLogFromConfig(cfg, log);
    const { app, routes } = await createApp({ ...gw, edge: envEdge(), corsOrigins: cfg.CAPSTAN_WEB_ORIGINS, requestLog: rl.middleware });
    const server = Bun.serve({ port: cfg.API_PORT, hostname: "127.0.0.1", idleTimeout: SERVER_IDLE_TIMEOUT_S, fetch: tel.serve(app.fetch) });
    log.info("listening", { port: cfg.API_PORT, routes: routes.length, corsOrigins: cfg.CAPSTAN_WEB_ORIGINS.length });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      setTimeout(() => process.exit(1), 3_000).unref();
      await server.stop();
      await rl.sink.close();
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
