// CORS for the web dashboard (todo 39 follow-up). The API answers CORS only for the exact origins in
// CAPSTAN_WEB_ORIGINS: the request's own origin is echoed back with Vary: Origin, never "*", and credentials
// (cookies) are never allowed, because every Capstan auth is a header (owner_sig, API key, x402). Any other origin
// gets no CORS header at all, so a browser on that origin cannot read the answer; a preflight from it is refused.
import { parseWebOrigins } from "@capstan/core";
import type { MiddlewareHandler } from "hono";
import { MESSAGE_HEADER, SIGNATURE_HEADER } from "./auth";

export { parseWebOrigins };

export const CORS_ALLOW_METHODS = ["GET", "POST", "DELETE"] as const;
/** Request headers a dashboard or SDK call may carry: JSON, the owner signature, an API key and x402 payments. */
export const CORS_ALLOW_HEADERS = ["accept", "content-type", "authorization", "x-api-key", MESSAGE_HEADER, SIGNATURE_HEADER, "payment-signature", "x-payment"] as const;
/** Answer headers a browser client must read: the x402 challenge and settle result, and the rate-limit wait. */
export const CORS_EXPOSE_HEADERS = ["payment-required", "payment-response", "x-payment-response", "retry-after"] as const;
export const CORS_MAX_AGE_S = 600;

function addVary(h: Headers): void {
  const v = h.get("vary");
  if (!v) h.set("vary", "Origin");
  else if (!v.split(/,\s*/).some((x) => x.toLowerCase() === "origin")) h.set("vary", `${v}, Origin`);
}

/** The CORS middleware for an exact origin list (already validated by parseWebOrigins). Empty list: a no-op. */
export function corsFor(origins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(origins.map((o) => o.toLowerCase()));
  return async (c, next) => {
    if (allowed.size === 0) return next();
    const origin = c.req.header("origin");
    const ok = origin !== undefined && allowed.has(origin.toLowerCase()) && origin === origin.toLowerCase();
    if (c.req.method === "OPTIONS" && c.req.header("access-control-request-method")) {
      const method = (c.req.header("access-control-request-method") ?? "").toUpperCase();
      const h = new Headers();
      addVary(h);
      if (!ok || !(CORS_ALLOW_METHODS as readonly string[]).includes(method)) return new Response(null, { status: 403, headers: h });
      h.set("access-control-allow-origin", origin!);
      h.set("access-control-allow-methods", CORS_ALLOW_METHODS.join(", "));
      h.set("access-control-allow-headers", CORS_ALLOW_HEADERS.join(", "));
      h.set("access-control-max-age", String(CORS_MAX_AGE_S));
      return new Response(null, { status: 204, headers: h });
    }
    await next();
    // set on the final answer (handlers, errors, 404s and raw x402 responses alike)
    const h = new Headers(c.res.headers);
    addVary(h);
    if (ok) {
      h.set("access-control-allow-origin", origin!);
      h.set("access-control-expose-headers", CORS_EXPOSE_HEADERS.join(", "));
    } else {
      h.delete("access-control-allow-origin");
      h.delete("access-control-allow-credentials");
    }
    c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: h });
  };
}
