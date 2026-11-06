// The usage report counts real requests (todo 45): the api middleware and the MCP server write request_logs, and
// computeDay reads them back. Rows hold the route pattern, a daily-salted client hash and the caller IP (kept 7 days
// by log-retention), never an API key, a raw path id or a raw client id.
import type { Db, RouteSpec } from "@capstan/core";
import { db as schema } from "@capstan/schema";
import { bufferedRequestLog, dailyClientHasher } from "@capstan/telemetry";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../../apps/api/src/app";
import { requestLogger } from "../../../apps/api/src/request-log";
import { localApi, mcp, rpc } from "../../../apps/mcp/test/helpers";
import { computeDay } from "../usage";
import { dbDescribe, freshDb, HOOK_TIMEOUT_MS } from "./helpers";

const KEY_VALUE = "cpst_live_requestlogtestvalue0001"; // a stand-in API key value; must never be stored
const WALLET = "0x00000000000000000000000000000000000000ab";

dbDescribe("request logs", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await freshDb()), HOOK_TIMEOUT_MS);
  afterAll(async () => await drop());
  const today = () => new Date().toISOString().slice(0, 10);

  test("api-request-counted: requests through the api middleware are counted by the usage report", async () => {
    const sink = bufferedRequestLog(db, { flushMs: 60_000 });
    const routes: RouteSpec[] = [
      { method: "GET", path: "/markets/:id/book", auth: "public", handler: (c) => c.json({ ok: true }) },
      { method: "GET", path: "/account", auth: "api_key", handler: (c) => c.json({ ok: true }) },
    ];
    const { app } = await createApp({
      routesDir: mkdtempSync(join(tmpdir(), "capstan-rl-routes-")),
      extraRoutes: routes,
      // the stand-in verifier admits the key and sets its id, as the real api_key verifier does
      verifiers: { api_key: (c) => ((c as unknown as { set(k: string, v: unknown): void }).set("apiKeyId", "key-1"), null) },
      requestLog: requestLogger({ sink, hash: dailyClientHasher(), ipOf: (c) => c.req.header("x-forwarded-for") ?? null, country: () => "DE" }),
    });
    const before = (await computeDay(today(), { db })).api.requests;
    expect((await app.request(`/v1/markets/hyperliquid:-:${WALLET}/book`, { headers: { "x-forwarded-for": "198.51.100.7" } })).status).toBe(200);
    expect((await app.request("/v1/account", { headers: { "x-forwarded-for": "198.51.100.8", authorization: `Bearer ${KEY_VALUE}` } })).status).toBe(200);
    expect((await app.request("/v1/account", { headers: { "x-forwarded-for": "198.51.100.8", authorization: `Bearer ${KEY_VALUE}` } })).status).toBe(200);
    await sink.close();
    const u = await computeDay(today(), { db });
    expect(u.api.requests - before).toBe(3);
    expect(u.api.uniqueClients).toBeGreaterThanOrEqual(2); // the IP caller and the key caller

    const rows = await db.select().from(schema.requestLogs);
    const api = rows.filter((r) => r.service === "api");
    expect(api.map((r) => r.route).sort()).toEqual(["GET /v1/account", "GET /v1/account", "GET /v1/markets/:id/book"]);
    expect(api.every((r) => r.status === 200 && r.ipCountry === "DE" && /^[0-9a-f]{16}$/.test(r.clientHash ?? ""))).toBe(true);
    // the two calls with one key share a hash; nothing raw is stored: no key value, no key id, no path id
    const keyRows = api.filter((r) => r.route === "GET /v1/account");
    expect(keyRows[0]!.clientHash).toBe(keyRows[1]!.clientHash);
    const dump = JSON.stringify(rows);
    for (const raw of [KEY_VALUE, "key-1", WALLET, "Bearer"]) expect(dump).not.toContain(raw);
  });

  test("mcp-call-counted: an MCP tool call is counted, list and initialize are not tool calls", async () => {
    const sink = bufferedRequestLog(db, { flushMs: 60_000 });
    const { api } = await localApi();
    const app = mcp(api, { requestLog: { sink, hash: dailyClientHasher() }, clientIpOf: () => "198.51.100.9" });
    const before = (await computeDay(today(), { db })).mcp;
    expect((await rpc(app, "tools/list")).status).toBe(200);
    expect((await rpc(app, "tools/call", { name: "capstan_markets", arguments: {} }, { authorization: `Bearer ${KEY_VALUE}` })).status).toBe(200);
    await sink.close();
    const u = await computeDay(today(), { db });
    expect(u.mcp.calls - before.calls).toBe(1);
    expect(u.mcp.uniqueClients).toBeGreaterThanOrEqual(1);
    const rows = (await db.select().from(schema.requestLogs)).filter((r) => r.service === "mcp");
    expect(rows.map((r) => r.route).sort()).toEqual(["tools/call", "tools/list"]);
    expect(JSON.stringify(rows)).not.toContain(KEY_VALUE);
  });

  test("log-never-fails-a-request: a broken sink still answers the caller", async () => {
    const { app } = await createApp({
      routesDir: mkdtempSync(join(tmpdir(), "capstan-rl-routes-")),
      extraRoutes: [{ method: "GET", path: "/ping2", auth: "public", handler: (c) => c.json({ ok: true }) }],
      requestLog: requestLogger({ sink: { write: () => { throw new Error("db down"); }, flush: async () => {}, close: async () => {} }, hash: (s) => s, ipOf: () => null }),
    });
    expect((await app.request("/v1/ping2")).status).toBe(200);
  });
});
