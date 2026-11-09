// R9: deny by default. A route without auth is refused at mount; an unknown path is a 404 JSON error.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, MountError } from "../src/app";

const dirs: string[] = [];
function routesDir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "capstan-routes-"));
  dirs.push(d);
  for (const [n, b] of Object.entries(files)) writeFileSync(join(d, n), b);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const route = (extra: string) => `export const routes = [{ method: "GET", path: "/thing", ${extra} handler: (c) => c.json({ ok: 1 }) }];\n`;

describe("api mount", () => {
  test("deny-by-default", async () => {
    // a route file without auth is refused when the app is built
    const noAuth = routesDir({ "a.routes.ts": route("") });
    await expect(createApp({ routesDir: noAuth })).rejects.toThrow(MountError);
    await expect(createApp({ routesDir: noAuth })).rejects.toThrow("a.routes.ts: route GET /thing has no auth (deny by default)");
    const badAuth = routesDir({ "a.routes.ts": route('auth: "open",') });
    await expect(createApp({ routesDir: badAuth })).rejects.toThrow("has no auth");

    // unknown path: 404 JSON with an error code
    const { app } = await createApp();
    const res = await app.request("/v1/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found." } });
    expect((await app.request("/elsewhere")).status).toBe(404);

    // an auth kind with no verifier registered answers 401, never runs the handler
    const sig = routesDir({ "a.routes.ts": route('auth: "owner_sig",') });
    const { app: a2 } = await createApp({ routesDir: sig });
    const r2 = await a2.request("/v1/thing");
    expect(r2.status).toBe(401);
    expect((await r2.json()).error.code).toBe("UNAUTHORIZED");
    // with a verifier it runs
    const { app: a3 } = await createApp({ routesDir: sig, verifiers: { owner_sig: () => null } });
    expect((await a3.request("/v1/thing")).status).toBe(200);
  });

  test("health route and sorted drop-in discovery; duplicates and unpriced x402 refused", async () => {
    const { app, routes } = await createApp();
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "api", degraded: false });
    expect(routes.find((r) => r.path === "/health")).toMatchObject({ auth: "public", file: "health.routes.ts" });
    const dup = routesDir({ "a.routes.ts": route('auth: "public",'), "b.routes.ts": route('auth: "public",') });
    await expect(createApp({ routesDir: dup })).rejects.toThrow("b.routes.ts: duplicate route GET /thing");
    const unpriced = routesDir({ "a.routes.ts": route('auth: "x402",') });
    await expect(createApp({ routesDir: unpriced })).rejects.toThrow("x402 route GET /thing has no price");
  });

  test("tRPC ping on /trpc", async () => {
    const { app } = await createApp();
    const res = await app.request("/trpc/ping");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { data: unknown } }).result.data).toEqual({ pong: true });
  });

  test("errors never leak internals", async () => {
    const boom = routesDir({ "a.routes.ts": `export const routes = [{ method: "GET", path: "/boom", auth: "public", handler: () => { throw new Error("db password is hunter2"); } }];\n` });
    const { app } = await createApp({ routesDir: boom });
    const res = await app.request("/v1/boom");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("hunter2");
    expect(JSON.parse(text)).toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal error." } });
  });
});
