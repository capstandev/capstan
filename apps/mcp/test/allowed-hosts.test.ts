// r1:9 F-3: Caddy forwards the public Host (api.<domain>) to the MCP server, but MCP_ALLOWED_HOSTS was never set on
// the server, so the SDK's DNS-rebinding check answered 403 to every hosted /mcp request while the loopback health
// probe stayed green. Now the server env template carries the public host, and on testnet or mainnet the server
// refuses to start with only the loopback default.
import { describe, expect, test } from "bun:test";
import { loadConfig } from "@capstan/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mcpAppFromEnv } from "../src/index";

const TEMPLATE = join(import.meta.dir, "../../../ops/server/etc/mcp.env");
const api = {} as never;

describe("MCP allowed hosts (r1:9 F-3)", () => {
  test("the server env template, rendered the way provision.sh renders it, allows the public api host", () => {
    const rendered = readFileSync(TEMPLATE, "utf8").replaceAll("@API_HOST@", "api.get-capstan.com");
    const line = rendered.split("\n").find((l) => l.startsWith("MCP_ALLOWED_HOSTS="));
    expect(line).toBeDefined();
    expect(line!.slice("MCP_ALLOWED_HOSTS=".length).split(",")).toContain("api.get-capstan.com");
  });

  for (const network of ["testnet", "mainnet"] as const) {
    test(`on ${network} the server refuses to start with only the loopback default`, async () => {
      const cfg = loadConfig("mcp", { CAPSTAN_NETWORK: network });
      await expect(mcpAppFromEnv(cfg, { CAPSTAN_NETWORK: network }, { api })).rejects.toThrow("MCP_ALLOWED_HOSTS");
    });
  }

  test("locally the loopback default still works", async () => {
    const cfg = loadConfig("mcp", { CAPSTAN_NETWORK: "local" });
    const { hosts } = await mcpAppFromEnv(cfg, {}, { api });
    expect(hosts).toEqual([`127.0.0.1:${cfg.MCP_PORT}`, `localhost:${cfg.MCP_PORT}`]);
  });
});

test("the deploy probe's request (tools/list with the public Host) answers 200 when the host is allowed and 403 when not", async () => {
  const cfg = loadConfig("mcp", { CAPSTAN_NETWORK: "local" });
  const probe = (host: string) => ({ method: "POST", headers: { host, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const ok = await mcpAppFromEnv(cfg, { MCP_ALLOWED_HOSTS: "api.get-capstan.com,127.0.0.1:8713" }, { api });
  expect((await ok.app.fetch(new Request("http://127.0.0.1:8713/mcp", probe("api.get-capstan.com")))).status).toBe(200);
  const bad = await mcpAppFromEnv(cfg, {}, { api });
  expect((await bad.app.fetch(new Request("http://127.0.0.1:8713/mcp", probe("api.get-capstan.com")))).status).toBe(403);
});
