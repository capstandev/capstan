// @capstan/relay: Signed-payload verifier and venue submitter.
// Boot only for now: validates the relay role's config and answers GET /health. The service code lands in its own todo.
import { loadConfig, logger } from "@capstan/core";

export const PACKAGE_NAME = "@capstan/relay" as const;

if (import.meta.main) {
  const log = logger("relay");
  try {
    const cfg = loadConfig("relay");
    Bun.serve({
      port: cfg.RELAY_PORT,
      hostname: "127.0.0.1",
      fetch: (req) => (new URL(req.url).pathname === "/health" ? Response.json({ ok: true, service: "relay" }) : Response.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 })),
    });
    log.info("listening", { port: cfg.RELAY_PORT });
  } catch (e) {
    log.error("boot failed", { error: (e as Error).message });
    process.exit(1);
  }
}
