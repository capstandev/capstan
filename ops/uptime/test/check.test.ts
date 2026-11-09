// ops/uptime/check.sh against a local stack (no outside calls: every run sets CAPSTAN_UPTIME_LOCAL_ONLY=1).
// The stack is the real API app and the real MCP app behind one front on 127.0.0.1 that routes like the VPS Caddy
// (/mcp* to MCP, the rest to the API, Host kept), plus a site stand-in. With DATABASE_URL and REDIS_URL set (the
// compose stack) the API's real Postgres and Redis checks run. Ports 25040 to 25049.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { healthProbe, loadConfig } from "../../../packages/core/src/index";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../../apps/api/src/app";
import { mcpAppFromEnv } from "../../../apps/mcp/src/index";

const SCRIPT = join(import.meta.dir, "..", "check.sh");
const MONITORS = JSON.parse(readFileSync(join(import.meta.dir, "..", "monitors.json"), "utf8")) as {
  bases: Record<string, string>;
  monitors: { id: string; base: string; path: string; url: string; method: string; keyword: string; expectStatus: number }[];
};
const SITE = 25044;
const FRONT = 25045; // the api.<domain> stand-in
const LOOSE = 25046; // a front whose MCP does not allow the Host (r1:9 F-3 shape)
const STUB = 25047; // hand-made answers for the failure cases
const DEAD = 25049; // nothing listens here
const local = (p: number) => `http://127.0.0.1:${p}`;

const servers: { stop(force?: boolean): void }[] = [];
let stubHealth: () => Response = () => Response.json({});

async function front(port: number, allowed: string) {
  const { app: api } = await createApp();
  const cfg = loadConfig("mcp", { CAPSTAN_NETWORK: "local", API_BASE_URL: `${local(port)}/v1` });
  const { app: mcp } = await mcpAppFromEnv(cfg, { MCP_ALLOWED_HOSTS: allowed, CAPSTAN_VERSION: "test" }, { api: {} as never });
  servers.push(Bun.serve({ port, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname.startsWith("/mcp") ? mcp.fetch(req) : api.fetch(req)) }));
}

beforeAll(async () => {
  servers.push(Bun.serve({ port: SITE, hostname: "127.0.0.1", fetch: () => new Response("<!doctype html><title>Capstan: One API for on-chain perps</title>", { headers: { "content-type": "text/html" } }) }));
  await front(FRONT, `127.0.0.1:${FRONT}`);
  await front(LOOSE, "api.get-capstan.com");
  servers.push(Bun.serve({ port: STUB, hostname: "127.0.0.1", fetch: () => stubHealth() }));
});
afterAll(() => servers.forEach((s) => s.stop(true)));

async function check(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawn(["bash", SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", CAPSTAN_UPTIME_LOCAL_ONLY: "1", CAPSTAN_UPTIME_TIMEOUT: "5", ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code, lines: out.trim().split("\n") };
}
const lineFor = (lines: string[], id: string) => lines.find((l) => l.split(" ")[1] === id) ?? "";

describe("monitors.json", () => {
  test("covers the site, the API health and the MCP endpoint; each url is its base plus its path", () => {
    expect(MONITORS.monitors.map((m) => m.id)).toEqual(["site", "api-health", "mcp-health"]);
    expect(MONITORS.bases).toEqual({ site: "https://get-capstan.com", api: "https://api.get-capstan.com" });
    for (const m of MONITORS.monitors) {
      expect(m.url).toBe(MONITORS.bases[m.base] + m.path);
      expect(m.method).toBe("GET");
      expect(m.expectStatus).toBe(200);
    }
    expect(MONITORS.monitors.find((m) => m.id === "mcp-health")!.url).toBe("https://api.get-capstan.com/mcp/health");
  });

  test("check.sh --list prints the same URLs without calling anything", async () => {
    const r = await check({ CAPSTAN_UPTIME_LOCAL_ONLY: "0" }, "--list");
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(MONITORS.monitors.map((m) => `${m.id} ${m.url}`));
  });
});

describe("check.sh on a local stack", () => {
  test("every monitor passes against the real API and MCP apps", async () => {
    const r = await check({ CAPSTAN_UPTIME_SITE_BASE: local(SITE), CAPSTAN_UPTIME_API_BASE: local(FRONT) });
    expect(r.err).toBe("");
    expect(r.lines.slice(0, 3).map((l) => l.split(" ").slice(0, 3).join(" "))).toEqual([
      `PASS site ${local(SITE)}/`,
      `PASS api-health ${local(FRONT)}/v1/health`,
      `PASS mcp-health ${local(FRONT)}/mcp/health`,
    ]);
    expect(r.lines.at(-1)).toBe("PASS 3/3 monitors");
    expect(r.code).toBe(0);
  });

  test("an MCP that would refuse the public Host fails the MCP monitor only", async () => {
    const r = await check({ CAPSTAN_UPTIME_SITE_BASE: local(SITE), CAPSTAN_UPTIME_API_BASE: local(LOOSE) });
    expect(lineFor(r.lines, "api-health")).toStartWith("PASS");
    expect(lineFor(r.lines, "mcp-health")).toStartWith("FAIL mcp-health");
    expect(lineFor(r.lines, "mcp-health")).toContain('keyword "degraded":false not in the body');
    expect(lineFor(r.lines, "mcp-health")).toContain('"failing":["host"]');
    expect(r.lines.at(-1)).toBe("FAIL 1 of 3 monitors");
    expect(r.code).toBe(1);
  });

  test("a site that is down fails with the request error", async () => {
    const r = await check({ CAPSTAN_UPTIME_SITE_BASE: local(DEAD), CAPSTAN_UPTIME_API_BASE: local(FRONT) });
    expect(lineFor(r.lines, "site")).toStartWith(`FAIL site ${local(DEAD)}/ request failed`);
    expect(r.code).toBe(1);
  });

  test("a degraded API, a wrong status and a cacheable answer each fail", async () => {
    const env = { CAPSTAN_UPTIME_SITE_BASE: local(SITE), CAPSTAN_UPTIME_API_BASE: local(STUB) };
    const { healthBody, healthResponse } = await import("../../../packages/core/src/index");
    stubHealth = () => new Response("{}", { status: 503 });
    expect(lineFor((await check(env)).lines, "api-health")).toContain("status 503, want 200");
    const degraded = await healthResponse(await healthBody("api", "t", healthProbe({ postgres: async () => false }))).text();
    stubHealth = () => new Response(degraded, { headers: { "cache-control": "no-store" } });
    expect(lineFor((await check(env)).lines, "api-health")).toContain('keyword "degraded":false not in the body');
    stubHealth = () => new Response('{"ok":true,"degraded":false}', { headers: { "cache-control": "max-age=60" } });
    const r = await check(env);
    expect(lineFor(r.lines, "api-health")).toContain("no Cache-Control: no-store header");
    expect(r.code).toBe(1);
  });

  test("with CAPSTAN_UPTIME_LOCAL_ONLY=1 the public URLs are refused, never called", async () => {
    const r = await check({});
    expect(r.lines.slice(0, 3)).toEqual(MONITORS.monitors.map((m) => `FAIL ${m.id} ${m.url} not a local URL (CAPSTAN_UPTIME_LOCAL_ONLY=1)`));
    expect(r.code).toBe(1);
  });

  test("a bad argument is a usage error", async () => {
    const r = await check({}, "--nope");
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage");
  });
});
