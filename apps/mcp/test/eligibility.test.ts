// R9 (todo 32): capstan_eligibility returns { allowed, code } and, when the region is refused, the text
// "Not available in your region." and nothing else. The MCP server forwards the caller's address, not its own.
// Needs DATABASE_URL.
import { afterAll, describe, expect, test } from "bun:test";
import { REGION_TEXT } from "../src/tools";
import { callTool } from "./helpers";
import { AGENT_IP, e2eStack, REFUSED_IP } from "./stack";

(process.env.DATABASE_URL ? describe : describe.skip)("eligibility over MCP", () => {
  const stacks: Awaited<ReturnType<typeof e2eStack>>[] = [];
  afterAll(async () => {
    for (const s of stacks) await s.stop();
  });

  test("text", async () => {
    const refused = await e2eStack({ mcp: { clientIpOf: () => REFUSED_IP } });
    stacks.push(refused);
    const r = await callTool({ request: (u: string, i: RequestInit) => refused.mcpFetch(u, i) }, "capstan_eligibility", { venue: "hyperliquid" });
    expect(r.structuredContent).toEqual({ allowed: false, code: "GEO_REFUSED" });
    expect(r.content).toEqual([{ type: "text", text: REGION_TEXT }]);
    expect(REGION_TEXT).toBe("Not available in your region.");
    // the API saw the caller's address (forwarded), never the MCP server's
    expect(refused.apiCalls.length).toBeGreaterThan(0);
    const ok = refused.apiCalls.find((c) => c.path.startsWith("/v1/eligibility"));
    expect(ok).toBeDefined();
    const allowed = await e2eStack({ mcp: { clientIpOf: () => AGENT_IP } });
    stacks.push(allowed);
    const a = await callTool({ request: (u: string, i: RequestInit) => allowed.mcpFetch(u, i) }, "capstan_eligibility", { venue: "hyperliquid" });
    const sc = a.structuredContent as { allowed: boolean; code: string | null };
    expect(Object.keys(sc).sort()).toEqual(["allowed", "code"]);
    expect(sc.code).not.toBe("GEO_REFUSED");
    expect(a.content[0]!.text).not.toBe(REGION_TEXT);
  }, 60_000);
});
