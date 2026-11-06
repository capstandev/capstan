// Todo 39 follow-up: the dashboard runs on its own origin, so the API answers CORS for the configured web origins
// only. An origin on the list gets its own origin echoed back (never "*"), the request headers the dashboard and the
// SDK send (owner_sig, API key, x402) and the 402 headers it must read; any other origin gets no CORS header at all.
// Credentials (cookies) are never allowed: every auth is a header.
import { loadConfig, ConfigError, type RouteSpec } from "@capstan/core";
import { describe, expect, test } from "bun:test";
import { CORS_ALLOW_HEADERS, parseWebOrigins } from "../src/cors";
import { ownerSigVerifier } from "../src/auth";
import { addr, gwKey, HOST, memoryNonceStore, signed, smallApp, T } from "./gw-helpers";

const WEB = "https://app.capstan.test";
const DEV = "http://127.0.0.1:23373";
const owner = gwKey("cors-owner");

const routes: RouteSpec[] = [
  { method: "GET", path: "/open", auth: "public", handler: (c) => c.json({ ok: true }) },
  { method: "GET", path: "/mine", auth: "owner_sig", handler: (c) => c.json({ owner: c.get("owner" as never) }) },
  { method: "POST", path: "/mine", auth: "owner_sig", handler: (c) => c.json({ owner: c.get("owner" as never) }) },
];

async function app(corsOrigins: string[] = [WEB, DEV]) {
  const verifiers = { owner_sig: ownerSigVerifier({ nonces: memoryNonceStore(), host: HOST, now: () => T + 1000, agentsOf: async () => [] }) };
  return (await smallApp(routes, { verifiers, corsOrigins })).app;
}

const preflight = (a: Awaited<ReturnType<typeof app>>, origin: string, method = "GET", headers = "x-capstan-message, x-capstan-signature") =>
  a.request("/v1/mine", { method: "OPTIONS", headers: { origin, "access-control-request-method": method, "access-control-request-headers": headers } });

describe("cors", () => {
  test("allowlist-only", async () => {
    const a = await app();
    // a listed origin: the preflight passes with its own origin echoed and the auth headers allowed
    for (const origin of [WEB, DEV]) {
      const r = await preflight(a, origin, "POST", "content-type, x-capstan-message, x-capstan-signature, authorization");
      expect(r.status).toBe(204);
      expect(r.headers.get("access-control-allow-origin")).toBe(origin);
      expect(r.headers.get("vary")?.toLowerCase()).toContain("origin");
      const allowed = (r.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(/,\s*/);
      for (const h of ["content-type", "authorization", "x-api-key", "x-capstan-message", "x-capstan-signature", "payment-signature", "x-payment"]) expect(allowed).toContain(h);
      expect((r.headers.get("access-control-allow-methods") ?? "").split(/,\s*/).sort()).toEqual(["DELETE", "GET", "POST"]);
      expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    }
    // any other origin (a look-alike, another port, a scheme change, null): no CORS header, preflight refused
    for (const origin of ["https://evil.example", "https://app.capstan.test.evil.example", "http://app.capstan.test", "http://127.0.0.1:23374", "null"]) {
      const r = await preflight(a, origin);
      expect(r.status).toBe(403);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      const g = await a.request("/v1/open", { headers: { origin } });
      expect(g.status).toBe(200);
      expect(g.headers.get("access-control-allow-origin")).toBeNull();
    }
    // a preflight for a method the API does not serve
    expect((await preflight(a, WEB, "PUT")).status).toBe(403);

    // an owner-signed read from the dashboard's origin: 200, readable by that origin only
    const signedGet = await a.request(`/v1/mine?owner=${addr(owner)}`, { headers: { origin: WEB, ...signed(owner, { method: "GET", path: `/v1/mine?owner=${addr(owner)}` }) } });
    expect(signedGet.status).toBe(200);
    expect(signedGet.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(signedGet.headers.get("vary")?.toLowerCase()).toContain("origin");
    expect(await signedGet.json()).toEqual({ owner: addr(owner) });
    // errors are readable too (the dashboard shows the API's message), and the 402 and rate-limit headers are exposed
    const refused = await a.request("/v1/mine", { method: "POST", headers: { origin: WEB, "content-type": "application/json" }, body: "{}" });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBe(WEB);
    const exposed = (refused.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    for (const h of ["payment-required", "payment-response", "retry-after"]) expect(exposed).toContain(h);
    const missing = await a.request("/v1/nothing-here", { headers: { origin: WEB } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe(WEB);

    // never "*", on any answer
    for (const r of [await preflight(a, WEB), signedGet, refused, missing]) expect(r.headers.get("access-control-allow-origin")).not.toBe("*");

    // no origins configured (the default): no CORS at all
    const none = await app([]);
    expect((await preflight(none, WEB)).headers.get("access-control-allow-origin")).toBeNull();
    expect((await none.request("/v1/open", { headers: { origin: WEB } })).headers.get("access-control-allow-origin")).toBeNull();
    expect(CORS_ALLOW_HEADERS).not.toContain("*");
  });

  test("origins-config", () => {
    expect(parseWebOrigins("")).toEqual([]);
    expect(parseWebOrigins(" https://app.capstan.test , http://127.0.0.1:23373 ")).toEqual(["https://app.capstan.test", "http://127.0.0.1:23373"]);
    expect(parseWebOrigins("HTTPS://App.Capstan.Test")).toEqual(["https://app.capstan.test"]);
    // a wildcard, a path, a trailing slash, credentials in the URL or another scheme are refused at boot
    for (const bad of ["*", "https://*.capstan.test", "https://app.capstan.test/", "https://app.capstan.test/app", "https://user@app.capstan.test", "ftp://app.capstan.test", "null", "app.capstan.test"]) expect(() => parseWebOrigins(bad)).toThrow();
    const base = { DATABASE_URL: "postgres://x@127.0.0.1:1/x", REDIS_URL: "redis://127.0.0.1:1" };
    expect(loadConfig("api", base).CAPSTAN_WEB_ORIGINS).toEqual([]);
    expect(loadConfig("api", { ...base, CAPSTAN_WEB_ORIGINS: "https://app.capstan.test" }).CAPSTAN_WEB_ORIGINS).toEqual(["https://app.capstan.test"]);
    let err: unknown = null;
    try {
      loadConfig("api", { ...base, CAPSTAN_WEB_ORIGINS: "*" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).names).toEqual(["CAPSTAN_WEB_ORIGINS"]);
  });
});
