// Hosted-mode proof (tracker 79): the production entry runs with MCP_ALLOWED_ORIGINS unset (ops/server/etc/mcp.env), and
// the SDK transport only checks Origin when the allow-list is non-empty, so a browser page on any origin was served
// (https://evil.example answered 200). Now an empty list means "no browser origin": a request that carries an Origin
// header is refused with 403 unless the origin is listed; agents and stdio bridges send no Origin and still pass.
import { describe, expect, test } from "bun:test";
import { loadConfig } from "@capstan/core";
import { mcpAppFromEnv } from "../src/index";
import { localApi, mcp, rpc } from "./helpers";

const probe = (headers: Record<string, string>) => new Request("http://127.0.0.1:8713/mcp", { method: "POST", headers: { host: "127.0.0.1:8713", "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

describe("MCP Origin rule with no allowed origins", () => {
  test("the production entry with MCP_ALLOWED_ORIGINS unset refuses any browser Origin and serves agents", async () => {
    const cfg = loadConfig("mcp", { CAPSTAN_NETWORK: "local" });
    const { api } = await localApi();
    const { app } = await mcpAppFromEnv(cfg, { MCP_ALLOWED_HOSTS: "127.0.0.1:8713" }, { api });
    const evil = await app.fetch(probe({ origin: "https://evil.example" }));
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    expect((await evil.json()) as unknown).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
    expect((await app.fetch(probe({ origin: "http://127.0.0.1:8713" }))).status).toBe(403);
    expect((await app.fetch(probe({ origin: "null" }))).status).toBe(403);
    expect((await app.fetch(probe({}))).status).toBe(200);
  });

  test("a listed origin is still served and an unlisted one refused", async () => {
    const cfg = loadConfig("mcp", { CAPSTAN_NETWORK: "local" });
    const { api } = await localApi();
    const { app } = await mcpAppFromEnv(cfg, { MCP_ALLOWED_HOSTS: "127.0.0.1:8713", MCP_ALLOWED_ORIGINS: "https://agent.example" }, { api });
    expect((await app.fetch(probe({ origin: "https://agent.example" }))).status).toBe(200);
    expect((await app.fetch(probe({ origin: "https://evil.example" }))).status).toBe(403);
  });

  test("createMcpApp with an empty allow-list refuses an Origin before any tool runs", async () => {
    const { api, seen } = await localApi();
    const app = mcp(api, { allowedOrigins: [] });
    const before = seen.length;
    const r = await rpc(app, "tools/call", { name: "capstan_markets", arguments: {} }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(seen.length).toBe(before);
    expect((await rpc(app, "tools/list")).status).toBe(200);
  });
});
