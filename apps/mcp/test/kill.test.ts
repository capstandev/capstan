// R6 (todo 32): capstan_kill returns relayBlocked true, the venue revocation bundle and, when asked, reduce-only
// close-all payloads; the next capstan_submit for that agent is refused within 1 s. Needs DATABASE_URL and REDIS_URL.
import { afterAll, describe, expect, test } from "bun:test";
import { capstanMessage } from "@capstan/core";
import { memoryKeyStore } from "@capstan/sdk";
import type { Hex, OnboardingBundle, UnsignedVenuePayload } from "@capstan/schema";
import { hashMessage } from "viem";
import { signDigestRsv } from "../../../packages/sdk/src/keys/secp";
import { callTool } from "./helpers";
import { signChecked, tslaShort } from "./sign";
import { API_HOST, API_KEY, e2eStack } from "./stack";
import { NOW } from "../../relay/test/helpers";

const ok = process.env.DATABASE_URL && process.env.REDIS_URL;


(ok ? describe : describe.skip)("kill over MCP", () => {
  let stack: Awaited<ReturnType<typeof e2eStack>>;
  afterAll(async () => stack?.stop());

  test("kill-then-refuse", async () => {
    stack = await e2eStack();
    const auth = { authorization: `Bearer ${API_KEY}` };
    const call = (name: string, args: unknown) => callTool({ request: (u: string, i: RequestInit) => stack.mcpFetch(u, i) }, name, args, auth);
    const ks = memoryKeyStore();
    const k = await ks.create("hyperliquid", "secp256k1");
    const agentAddress = k.publicPart.toLowerCase() as Hex;
    const agentRef = await stack.delegate(agentAddress);
    // a valid build, signed before the kill
    const intent = tslaShort();
    const built = await call("capstan_build_order", { owner: stack.owner, agentRef, intent, mode: "relay" });
    expect(built.isError).toBeUndefined();
    const env = await signChecked(intent, built.structuredContent as unknown as UnsignedVenuePayload, { keystore: ks, keyRef: k.ref, agentAddress, owner: stack.owner });
    // the owner's signed kill, with close-all payloads
    const message = capstanMessage({ purpose: "kill", owner: stack.owner, host: API_HOST, chainId: 4663, nonce: "mcp-kill-0001", issuedAt: NOW - 1000, expiresAt: NOW + 60_000, body: agentRef });
    const t0 = performance.now();
    const killed = await call("capstan_kill", { agentRef, sig: signDigestRsv(hashMessage(message), stack.ownerKey), message, closeAll: true });
    if (killed.isError) console.log(killed.content[0]!.text);
    expect(killed.isError).toBeUndefined();
    const kb = killed.structuredContent as { relayBlocked: boolean; revocation: OnboardingBundle | null; closeAll?: UnsignedVenuePayload[]; receiptId: string; by: string };
    expect(kb.relayBlocked).toBe(true);
    expect(kb.by).toBe("owner");
    expect(kb.revocation?.steps.some((s) => s.kind === "revoke_agent")).toBe(true);
    expect(Array.isArray(kb.closeAll)).toBe(true);
    expect(kb.closeAll!.length).toBeGreaterThan(0);
    expect(kb.closeAll!.every((p) => p.preview.reduceOnly)).toBe(true);
    // the next submit for that agent: refused, within 1 s of the kill
    let code: string | null = null;
    while (performance.now() - t0 < 1000) {
      const r = await call("capstan_submit", { buildId: env.buildId, signedEnvelope: env });
      code = r.isError ? ((r.structuredContent as { error: { code: string } }).error.code) : null;
      if (code === "AGENT_KILLED") break;
    }
    expect(code).toBe("AGENT_KILLED");
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(stack.relay.venues.hl.length).toBe(0); // nothing was sent
    ks.close?.();
  }, 60_000);
});
