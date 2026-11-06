// R8 (todo 32): capstan_set_policy stores a policy the owner's wallet signed; a later capstan_build_order that breaches
// it answers POLICY_BREACH with the field, before anything is signed. Needs DATABASE_URL and REDIS_URL.
import { afterAll, describe, expect, test } from "bun:test";
import { policyTypedData } from "@capstan/policy";
import type { AgentPolicy, Hex } from "@capstan/schema";
import { hashTypedData } from "viem";
import { signDigestRsv } from "../../../packages/sdk/src/keys/secp";
import { NOW } from "../../relay/test/helpers";
import { callTool } from "./helpers";
import { tslaShort } from "./sign";
import { API_KEY, e2eStack, TSLA } from "./stack";

const ok = process.env.DATABASE_URL && process.env.REDIS_URL;

(ok ? describe : describe.skip)("policy over MCP", () => {
  let stack: Awaited<ReturnType<typeof e2eStack>>;
  afterAll(async () => stack?.stop());

  test("breach", async () => {
    stack = await e2eStack();
    const call = (name: string, args: unknown) => callTool({ request: (u: string, i: RequestInit) => stack.mcpFetch(u, i) }, name, args, { authorization: `Bearer ${API_KEY}` });
    const agentRef = await stack.delegate("0x00000000000000000000000000000000000000f5" as Hex);
    const policy: AgentPolicy = { owner: stack.owner, agents: [{ venue: "hyperliquid", agentRef }], maxNotionalPerOrderUsd: "100", maxGrossNotionalUsd: "1000", maxLeverage: 3, allowedMarkets: [TSLA], allowedVenues: ["hyperliquid"], maxOrdersPerDay: 10, expiresAt: new Date(NOW + 86_400_000).toISOString(), nonce: "mcp-policy-0001" };
    const ownerSig = signDigestRsv(hashTypedData(policyTypedData(policy) as never), stack.ownerKey);
    const stored = await call("capstan_set_policy", { policy, ownerSig });
    expect(stored.isError).toBeUndefined();
    expect((stored.structuredContent as { policyId: string }).policyId).toMatch(/.+/);
    // a forged signature is refused
    const forged = await call("capstan_set_policy", { policy: { ...policy, nonce: "mcp-policy-0002" }, ownerSig: signDigestRsv(hashTypedData(policyTypedData({ ...policy, nonce: "mcp-policy-0002" }) as never), new Uint8Array(32).fill(7)) });
    expect(forged.isError).toBe(true);
    // 1 TSLA is about 350 USD: above the 100 USD per-order cap
    const r = await call("capstan_build_order", { owner: stack.owner, agentRef, intent: tslaShort("1.000"), mode: "relay" });
    expect(r.isError).toBe(true);
    const e = (r.structuredContent as { error: { code: string; message: string; receiptId?: string } }).error;
    expect(e.code).toBe("POLICY_BREACH");
    expect(e.message).toContain("maxNotionalPerOrderUsd");
    expect(e.receiptId).toBeDefined();
    // within the cap the build goes through
    const small = await call("capstan_build_order", { owner: stack.owner, agentRef, intent: tslaShort("0.200"), mode: "relay" });
    expect(small.isError).toBeUndefined();
  }, 60_000);
});
