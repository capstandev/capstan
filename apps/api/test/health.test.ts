// GET /v1/health (ops/uptime): a quick, never-cached 200 with the version and a degraded flag. Postgres and Redis
// checks come from the environment; with the local stack (DATABASE_URL and REDIS_URL set) the real checks pass.
import { describe, expect, test } from "bun:test";
import { healthProbe } from "@capstan/core";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { createHealthRoutes, envHealthChecks } from "../src/routes/health.routes";

const stack = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;

function appWith(checks: Parameters<typeof healthProbe>[0], version = "abc1234") {
  const app = new Hono();
  const [spec] = createHealthRoutes(() => ({ version, probe: healthProbe(checks, { timeoutMs: 100 }) }));
  app.get("/v1/health", spec!.handler);
  return app;
}

describe("GET /v1/health", () => {
  test("the mounted route answers 200, never cached, with ok, version and degraded", async () => {
    const { app } = await createApp();
    const r = await app.request("/v1/health");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("no-store");
    const b = (await r.json()) as Record<string, unknown>;
    expect(b).toMatchObject({ ok: true, service: "api" });
    expect(typeof b.version).toBe("string");
    expect((b.version as string).length).toBeGreaterThan(0);
    expect(typeof b.degraded).toBe("boolean");
    expect(Array.isArray(b.failing)).toBe(true);
  });

  test("a dependency that fails or hangs shows as degraded, still a quick 200", async () => {
    const app = appWith({ postgres: async () => undefined, redis: () => new Promise(() => {}) });
    const t0 = performance.now();
    const r = await app.request("/v1/health");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, service: "api", version: "abc1234", degraded: true, failing: ["redis"] });
    const healthy = await appWith({ postgres: async () => undefined }).request("/v1/health");
    expect(((await healthy.json()) as { degraded: boolean }).degraded).toBe(false);
  });

  test("checks come from the environment: none without URLs, postgres and redis with them", () => {
    expect(Object.keys(envHealthChecks({}))).toEqual([]);
    expect(Object.keys(envHealthChecks({ DATABASE_URL: "postgres://x@127.0.0.1:1/x", REDIS_URL: "redis://127.0.0.1:1" }))).toEqual(["postgres", "redis"]);
  });

  test("a Postgres that refuses the connection is degraded within the cap", async () => {
    const probe = healthProbe(envHealthChecks({ DATABASE_URL: "postgres://capstan:x@127.0.0.1:25049/capstan" }), { timeoutMs: 400 });
    const t0 = performance.now();
    expect(await probe.failing()).toEqual(["postgres"]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test.skipIf(!stack)("with the local stack the real Postgres and Redis checks pass", async () => {
    const probe = healthProbe(envHealthChecks(process.env), { timeoutMs: 2000 });
    expect(await probe.failing()).toEqual([]);
  });
});
