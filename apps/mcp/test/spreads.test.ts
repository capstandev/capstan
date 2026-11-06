// R7 (todo 32): capstan_spread_plan returns the plan with riskLabel and ackRequired true (the real spread routes of
// todo 21 behind the local API); no tool executes a spread on the server: no tool reports leg events or submits
// orders on its own, and no tool source calls the spread executor.
import { describe, expect, test } from "bun:test";
import { memoryNonceStore } from "@capstan/core";
import { memoryPlanStore } from "@capstan/spreads";
import type { SpreadPlan } from "@capstan/schema";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { testWallet } from "../../../packages/policy/test/accounts";
import { setup } from "../../../packages/spreads/test/scan/helpers";
import { createSpreadRoutes } from "../../api/src/routes/spreads.routes";
import { allTools } from "../src/tools";
import { callTool, localApi, mcp } from "./helpers";

describe("spreads over MCP", () => {
  test("label-and-client-only", async () => {
    const s = setup();
    const store = memoryPlanStore();
    const routes = createSpreadRoutes(() => ({ planDeps: { ...s.deps, store }, store, events: { receipts: { issue: async () => ({ receiptId: "r" }) }, venueFill: async () => null }, nonces: memoryNonceStore(), host: "api.capstan.test", agentsOf: async () => [] }));
    const owner = testWallet("mcp spread owner").address;
    // stand-in for a valid owner_sig by this owner (the owner check itself is apps/api/test/spreads-owner.test.ts)
    const signedByOwner = (c: { set(k: string, v: unknown): void }) => (c.set("owner", owner.toLowerCase()), null);
    const { api, seen } = await localApi(routes, { verifiers: { owner_sig: signedByOwner as never } });
    const app = mcp(api);
    const r = await callTool(app, "capstan_spread_plan", { owner, equivalenceId: "eq-eth", sizeBase: "1", leverage: 3, hedgeFailurePolicy: "flatten_leg_a" });
    expect(r.isError).toBeUndefined();
    const p = r.structuredContent as unknown as SpreadPlan;
    expect(p.riskLabel).toBe("At-risk. Legging risk is yours.");
    expect(p.ackRequired).toBe(true);
    expect(p.status).toBe("draft");
    const st = await callTool(app, "capstan_plan_status", { planId: p.planId });
    expect((st.structuredContent as { plan: SpreadPlan }).plan.status).toBe("draft"); // still a draft: nothing ran
    // the only API calls were the plan and its status read
    expect(seen.map((q) => `${q.method} ${new URL(q.url).pathname}`)).toEqual(["POST /v1/spreads/plan", `GET /v1/spreads/${p.planId}`]);
    // no tool can execute a spread or report its legs
    expect(allTools().map((t) => t.name).filter((n) => /execute|event|leg/.test(n))).toEqual([]);
    const dir = join(import.meta.dir, "../src/tools");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src.includes("/events"), f).toBe(false);
      expect(/executeSpread|clientSpreadPorts/.test(src), f).toBe(false);
    }
  });
});
