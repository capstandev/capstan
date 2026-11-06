// User alert webhooks (spec 9 alerts, 13.1).
// POST   /v1/alerts/webhooks        register: owner signature, purpose webhook_register, body = URL + "\n" + kinds
// GET    /v1/alerts/webhooks?owner= list (owner read signature, purpose read); shows why a webhook was turned off
// DELETE /v1/alerts/webhooks/{id}   remove: owner signature, purpose webhook_register, body "remove <id>"
// The signing value is shown once at registration and only its hash is stored. URLs pass the outbound guard.
import { createDb, createRedis, memoryNonceStore, redisNonceStore, type Db, type NonceStore, type RouteSpec } from "@capstan/core";
import { verifyOwnerRead } from "@capstan/risk";
import { errorBody, type Hex } from "@capstan/schema";
import { alertKeyFromEnv } from "@capstan/workers/src/jobs/alerts-dispatch.job";
import { ALERT_KINDS, listWebhooks, registerWebhook, removeWebhook, secretDeriver, WebhookError, type AlertKind, type Resolver } from "@capstan/workers/src/alerts";
import type { Context } from "hono";

export interface AlertRouteDeps {
  db: Db;
  nonces: NonceStore;
  host: string;
  deriveSecret: (id: string) => string;
  resolver?: Resolver;
  now?: () => number;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;

function fail(c: Context, e: unknown): Response {
  if (e instanceof WebhookError) return c.json(errorBody(e.code, e.message), e.code === "UNAUTHORIZED" ? 401 : e.code === "NOT_FOUND" ? 404 : 400);
  throw e;
}

async function body(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createAlertRoutes(getDeps: () => Promise<AlertRouteDeps> | AlertRouteDeps): RouteSpec[] {
  return [
    {
      method: "POST",
      path: "/alerts/webhooks",
      auth: "owner_sig",
      description: "Register a webhook for your alerts: liquidation distance, unhedged spread plans, approval expiry, policy refusals",
      async handler(c) {
        const b = await body(c);
        if (!b || typeof b.owner !== "string" || !ADDR.test(b.owner) || typeof b.url !== "string" || !Array.isArray(b.kinds) || typeof b.sig !== "string" || !SIG.test(b.sig) || typeof b.message !== "string") {
          return c.json(errorBody("INVALID_INPUT", `body: { owner, url, kinds (${ALERT_KINDS.join(", ")}), sig, message }`), 400);
        }
        const deps = await getDeps();
        try {
          const r = await registerWebhook(deps.db, b.owner as Hex, b.url, b.kinds as AlertKind[], b.sig as Hex, { message: b.message, host: deps.host, nowMs: (deps.now ?? Date.now)(), nonces: deps.nonces, deriveSecret: deps.deriveSecret, ...(deps.resolver ? { resolver: deps.resolver } : {}) });
          return c.json({ ...r, note: "Keep this signing value: it is shown only once. Check X-Capstan-Signature (HMAC-SHA256 of the body) on every delivery." });
        } catch (e) {
          return fail(c, e);
        }
      },
    },
    {
      method: "GET",
      path: "/alerts/webhooks",
      auth: "owner_sig",
      description: "Your alert webhooks and their state",
      async handler(c) {
        const owner = c.req.query("owner") ?? "";
        if (!ADDR.test(owner)) return c.json(errorBody("INVALID_INPUT", "owner must be an address"), 400);
        const deps = await getDeps();
        const u = new URL(c.req.url);
        const v = await verifyOwnerRead(c.req.raw.headers, { owner: owner as Hex, method: "GET", pathWithQuery: `${u.pathname}${u.search}`, host: deps.host, nowMs: (deps.now ?? Date.now)() }, deps.nonces);
        if (!v.ok) return c.json(errorBody("UNAUTHORIZED", `Sign this read with your wallet (${v.reason}).`), 401);
        return c.json({ webhooks: await listWebhooks(deps.db, owner as Hex) });
      },
    },
    {
      method: "DELETE",
      path: "/alerts/webhooks/:id",
      auth: "owner_sig",
      description: "Remove one of your alert webhooks",
      async handler(c) {
        const id = c.req.param("id") ?? "";
        const b = await body(c);
        if (!b || typeof b.owner !== "string" || !ADDR.test(b.owner) || typeof b.sig !== "string" || !SIG.test(b.sig) || typeof b.message !== "string") return c.json(errorBody("INVALID_INPUT", "body: { owner, sig, message }"), 400);
        const deps = await getDeps();
        try {
          await removeWebhook(deps.db, b.owner as Hex, id, b.sig as Hex, { message: b.message, host: deps.host, nowMs: (deps.now ?? Date.now)(), nonces: deps.nonces });
          return c.json({ removed: id });
        } catch (e) {
          return fail(c, e);
        }
      },
    },
  ];
}

let resolved: Promise<AlertRouteDeps> | null = null;

async function envDeps(): Promise<AlertRouteDeps> {
  const env = process.env;
  if (!env.DATABASE_URL) throw new Error("alert routes need DATABASE_URL");
  const redis = env.REDIS_URL ? createRedis(env.REDIS_URL) : null;
  return {
    db: createDb(env.DATABASE_URL, { max: 2 }),
    nonces: redis ? redisNonceStore(redis) : memoryNonceStore(),
    host: env.PUBLIC_API_HOST ?? "localhost:8710",
    deriveSecret: secretDeriver(alertKeyFromEnv(env)),
  };
}

export const routes: RouteSpec[] = createAlertRoutes(() => (resolved ??= envDeps()));
