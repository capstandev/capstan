// Request log for every mounted route (spec 14, usage report todo 45): one request_logs row per call with the route
// PATTERN (never the raw path, so no address or id from the URL), the status, the duration, a client hash (API key
// id, else signed wallet, else caller IP, hashed with a salt that lives only in memory for one UTC day), the caller
// IP (kept 7 days; the log-retention job then leaves only ip_country) and its country. No key, signature or body is
// ever read. Writes are buffered: a request never waits on the log.
import type { RouteSpec } from "@capstan/core";
import type { RequestLogSink } from "@capstan/telemetry";
import type { Context, MiddlewareHandler } from "hono";

export interface RequestLogDeps {
  sink: RequestLogSink;
  /** Hash for a client id (dailyClientHasher in production). */
  hash: (clientId: string) => string;
  ipOf: (c: Context) => string | null;
  country?: (ip: string) => string | null;
  now?: () => number;
}

const ctxGet = (c: Context, k: string): unknown => (c as unknown as { get(k: string): unknown }).get(k);

/** The caller as the auth gate saw it: API key id, else the signed wallet, else the IP. */
export function clientIdOf(c: Context, ip: string | null): string | null {
  const key = ctxGet(c, "apiKeyId");
  if (typeof key === "string" && key) return `key:${key}`;
  const owner = ctxGet(c, "owner");
  if (ctxGet(c, "authKind") === "owner_sig" && typeof owner === "string" && owner) return `wallet:${owner.toLowerCase()}`;
  return ip ? `ip:${ip}` : null;
}

export function requestLogger(deps: RequestLogDeps): (spec: RouteSpec) => MiddlewareHandler {
  const now = deps.now ?? Date.now;
  return (spec) => {
    const route = `${spec.method} /v1${spec.path}`;
    return async (c, next) => {
      const t0 = now();
      try {
        await next();
      } finally {
        try {
          const ip = deps.ipOf(c) || null;
          const id = clientIdOf(c, ip);
          deps.sink.write({
            service: "api",
            route,
            clientHash: id ? deps.hash(id) : null,
            ip,
            ipCountry: ip && deps.country ? deps.country(ip) : null,
            status: c.res?.status ?? 500,
            durationMs: Math.round(now() - t0),
            ts: new Date(t0),
          });
        } catch {
          // the log never fails a request
        }
      }
    };
  };
}
