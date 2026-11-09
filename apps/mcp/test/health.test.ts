// GET /health and GET /mcp/health (ops/uptime). /mcp/health is the outside monitor's path: Caddy routes /mcp* to the
// MCP process, so it proves the public route; a Host the transport would refuse (r1:9 F-3) shows as degraded.
import { describe, expect, test } from "bun:test";
import { healthProbe, loadConfig } from "@capstan/core";
import { apiHealthCheck, mcpAppFromEnv } from "../src/index";
import { MCP_HOST, mcp } from "./helpers";

const api = {} as never;
const get = (app: { request(u: string, i?: RequestInit): Response | Promise<Response> }, path: string, host = MCP_HOST) =>
  Promise.resolve(app.request(`http://${host}${path}`, { headers: { host } }));

describe("MCP health", () => {
  test("both paths answer a never-cached 200 with version and degraded false when the api answers", async () => {
    const app = mcp(api, { health: { version: "abc1234", probe: healthProbe({ api: async () => undefined }) } });
    for (const path of ["/health", "/mcp/health"]) {
      const r = await get(app, path);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toContain("no-store");
      expect(await r.json()).toEqual({ ok: true, service: "mcp", version: "abc1234", degraded: false, failing: [] });
    }
  });

  test("an api that does not answer shows as degraded on both paths", async () => {
    const app = mcp(api, { health: { version: "v", probe: healthProbe({ api: async () => { throw new Error("down"); } }) } });
    expect(await (await get(app, "/health")).json()).toMatchObject({ degraded: true, failing: ["api"] });
    expect(await (await get(app, "/mcp/health")).json()).toMatchObject({ degraded: true, failing: ["api"] });
  });

  test("/mcp/health is degraded with host when the public Host is not in MCP_ALLOWED_HOSTS", async () => {
    const app = mcp(api, { health: { version: "v" } });
    const r = await get(app, "/mcp/health", "api.get-capstan.com");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, degraded: true, failing: ["host"] });
    // the loopback /health has no host rule (the deploy probe checks the host with its own tools/list request)
    expect(await (await get(app, "/health", "api.get-capstan.com")).json()).toMatchObject({ degraded: false });
  });

  test("from the environment: version from CAPSTAN_VERSION, the api check hits API_BASE_URL/health", async () => {
    const seen: string[] = [];
    const f = (async (u: string | URL | Request) => (seen.push(String(u)), new Response("{}", { status: 503 }))) as unknown as typeof fetch;
    await expect(apiHealthCheck("http://127.0.0.1:8710/v1/", f)()).rejects.toThrow("api health 503");
    expect(seen).toEqual(["http://127.0.0.1:8710/v1/health"]);
    const ok = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(apiHealthCheck("http://127.0.0.1:8710/v1", ok)()).resolves.toBeUndefined();

    const cfg = loadConfig("mcp", { CAPSTAN_NETWORK: "local", API_BASE_URL: "http://127.0.0.1:25049/v1" });
    const { app } = await mcpAppFromEnv(cfg, { CAPSTAN_VERSION: "rel-9" }, { api });
    const r = await get(app, "/mcp/health", `127.0.0.1:${cfg.MCP_PORT}`);
    // nothing listens on 25049, so the api check fails fast and the answer says so
    expect(await r.json()).toEqual({ ok: true, service: "mcp", version: "rel-9", degraded: true, failing: ["api"] });
  });
});
