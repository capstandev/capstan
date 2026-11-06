// R4 (todo 31): stateless Streamable HTTP: concurrent requests get independent server instances; no session id.
import { describe, expect, test } from "bun:test";
import { localApi, mcp, rpc } from "./helpers";

describe("stateless", () => {
  test("no-session", async () => {
    const { api } = await localApi();
    let servers = 0;
    const app = mcp(api, { wrap: (t, h) => (t.name === "capstan_markets" && servers++, h) });
    const [a, b] = await Promise.all([rpc(app, "tools/list"), rpc(app, "tools/list")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(servers).toBe(2); // one McpServer per request
    for (const r of [a, b]) expect(r.headers.get("mcp-session-id")).toBeNull();
    // a request needs no prior initialize (no session state to keep)
    const c = await rpc(app, "tools/call", { name: "capstan_markets", arguments: {} });
    expect(c.body.result.isError).toBeUndefined();
    expect(servers).toBe(3);
  });
});
