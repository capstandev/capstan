// R1 (todo 31, extended by 32): tools/list over Streamable HTTP returns exactly the Capstan tools, with protocol
// 2025-11-25 (the client sends Accept: application/json, text/event-stream).
import { describe, expect, test } from "bun:test";
import { TOOLS_V1 } from "../src/tools";
import { localApi, mcp, rpc } from "./helpers";

describe("tools/list", () => {
  test("six-tools", async () => {
    const { api } = await localApi();
    const app = mcp(api, { tools: TOOLS_V1 });
    const init = await rpc(app, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test-host", version: "1" } });
    expect(init.status).toBe(200);
    expect(init.body.result.protocolVersion).toBe("2025-11-25");
    expect(init.body.result.serverInfo.name).toBe("capstan");
    const list = await rpc(app, "tools/list");
    const names = (list.body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["capstan_markets", "capstan_quote", "capstan_build_order", "capstan_submit", "capstan_positions", "capstan_risk"]);
    // a client that does not accept JSON or SSE is refused by the transport
    const bad = await app.request("http://mcp.capstan.test/mcp", { method: "POST", headers: { host: "mcp.capstan.test", "content-type": "application/json", accept: "text/plain" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(bad.status).toBe(406);
  });
});

// R1 (todo 32): the full 17 tools of spec 13.3 with the input shapes listed there. Extra fields are only the signature
// inputs a route needs (the owner's read or request signature, the signed kill text) and the optional onboarding limits.
export const SPEC_INPUTS: Record<string, string[]> = {
  capstan_markets: ["venue", "asset", "executableOnly"],
  capstan_funding: ["asset"],
  capstan_quote: ["canonicalAsset", "marketIds", "side", "sizeBase", "notionalUsd", "leverage", "holdHours", "orderType", "limitPx", "owner"],
  capstan_onboarding_build: ["venue", "owner", "agentAddress", "lighterPubKey"],
  capstan_build_order: ["owner", "agentRef", "intent", "mode"],
  capstan_submit: ["buildId", "signedEnvelope"],
  capstan_cancel_build: ["owner", "agentRef", "venueOrderId"],
  capstan_positions: ["owner", "venues"],
  capstan_risk: ["owner", "addresses"],
  capstan_spread_scan: ["asset", "minBreakevenHours"],
  capstan_spread_plan: ["owner", "equivalenceId", "sizeBase", "leverage", "hedgeFailurePolicy"],
  capstan_plan_status: ["planId"],
  capstan_set_policy: ["policy", "ownerSig"],
  capstan_kill: ["agentRef", "sig", "closeAll"],
  capstan_get_receipt: ["receiptId"],
  capstan_verify_receipt: ["receiptId", "receipt"],
  capstan_eligibility: ["venue"],
};
const EXTRA_ALLOWED = new Set(["ownerRead", "requestSignature", "message", "builderMaxBps", "policy"]);

describe("tools/list, all tools", () => {
  test("seventeen", async () => {
    const { api } = await localApi();
    const tools = (await rpc(mcp(api), "tools/list")).body.result.tools as { name: string; inputSchema: { properties: Record<string, unknown>; additionalProperties?: boolean } }[];
    expect(tools.map((t) => t.name)).toEqual(Object.keys(SPEC_INPUTS));
    expect(tools.length).toBe(17);
    for (const t of tools) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      for (const f of SPEC_INPUTS[t.name]!) expect(props, `${t.name}.${f}`).toContain(f);
      for (const p of props) expect(SPEC_INPUTS[t.name]!.includes(p) || EXTRA_ALLOWED.has(p), `${t.name} has an unlisted field ${p}`).toBe(true);
      expect(t.inputSchema.additionalProperties).toBe(false); // strict: nothing else is accepted
    }
  });
});
