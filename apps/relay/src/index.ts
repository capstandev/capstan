// @capstan/relay: signed-payload verifier and venue submitter. It holds no user key and never changes a payload.
// The process consumes the relay-submit queue (the api enqueues and waits up to 10 s) and answers GET /health.
import { createRedis, logger } from "@capstan/core";
import { initTelemetry, telemetryEnv } from "@capstan/telemetry";
import { relayHttp } from "./health";
import { startRelayWorker } from "./queue";
import { startPendingSweep } from "./sweep";
import { relayConfig, relayRuntime } from "./wire";

export const PACKAGE_NAME = "@capstan/relay" as const;
export * from "./types";
export * from "./ip";
export * from "./flags";
export * from "./lanes";
export * from "./kill";
export * from "./dispatch";
export * from "./venues";
export * from "./stores";
export * from "./pipeline";
export * from "./queue";
export * from "./health";
export * from "./sweep";
export { dbPolicySource, passThroughGovernor, queuedReceipts, relayVenues } from "./wire";

if (import.meta.main) {
  const log = logger("relay");
  try {
    const cfg = relayConfig();
    const tel = initTelemetry("relay", telemetryEnv(process.env)); // traces + /metrics
    const rt = await relayRuntime(cfg, process.env, (msg, fields) => log.info(msg, fields));
    const worker = startRelayWorker(createRedis(cfg.REDIS_URL, { forBullmq: true }), rt.deps);
    const stopSweep = startPendingSweep(rt.deps); // rows a stopped run left with no venue answer (R2-RELAY-03)
    Bun.serve({
      port: cfg.RELAY_PORT,
      hostname: "127.0.0.1",
      fetch: tel.serve(relayHttp(rt.flags)),
    });
    const stop = async () => {
      stopSweep();
      await worker.close();
      await rt.close();
      await rt.kill.close();
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    log.info("listening", { port: cfg.RELAY_PORT, venues: [...rt.deps.venues.keys()], submitArmed: rt.flags.submitArmed() });
  } catch (e) {
    log.error("boot failed", { error: (e as Error).message });
    process.exit(1);
  }
}
