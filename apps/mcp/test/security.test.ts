// R5 (todo 31): DNS rebinding protection: a Host not in allowedHosts is refused, so is an Origin not allowed. And
// capstan_submit refuses any input field other than buildId and signedEnvelope (strict schema).
import { describe, expect, test } from "bun:test";
import { callTool, localApi, mcp, rpc } from "./helpers";

describe("security", () => {
  test("host-check", async () => {
    const { api, seen } = await localApi();
    const app = mcp(api);
    expect((await rpc(app, "tools/list")).status).toBe(200);
    const evilHost = await app.request("http://evil.example/mcp", { method: "POST", headers: { host: "evil.example", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(evilHost.status).toBe(403);
    expect((await rpc(app, "tools/list", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await rpc(app, "tools/list", undefined, { origin: "https://agent.example" })).status).toBe(200);
    // strict submit input: an extra field (a key, say) never reaches the API
    const before = seen.length;
    const r = await callTool(app, "capstan_submit", { buildId: "01JBUILD000000000000000000", signedEnvelope: { buildId: "01JBUILD000000000000000000", venue: "hyperliquid", encoding: "hl_l1_action", signedBody: {}, signature: "0x00", signerRef: "x", payloadHash: "0x00" }, agentKey: "0x1234" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("agentKey");
    expect(seen.length).toBe(before);
  });
});
