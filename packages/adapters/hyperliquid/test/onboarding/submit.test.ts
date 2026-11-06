// R4: only the main wallet's signatures are forwarded; the agent key can never sign the builder approval.
import { describe, expect, test } from "bun:test";
import { CapstanError } from "@capstan/schema";
import { buildOnboarding, submitOnboarding } from "../../src";
import { fixtureHttp } from "../helpers";
import { AGENT_KEY, context, NOW, OWNER, OWNER_KEY, request, signAll } from "./util";

const okExchange = (b: Record<string, any>) => (b.__path === "/exchange" ? { status: "ok", response: { type: "default" } } : undefined);

describe("submit", () => {
  test("agent-cannot-sign-builder", async () => {
    const { ctx } = context();
    const bundle = await buildOnboarding(request(), ctx);
    const builderIdx = bundle.steps.findIndex((s) => s.kind === "hl_approve_builder_fee");
    // the owner signs everything except the builder step, which the agent key signed
    const mixed = signAll(bundle, (i) => (i === builderIdx ? AGENT_KEY : OWNER_KEY));
    const http = fixtureHttp(okExchange);
    const err = await submitOnboarding(mixed, http, { bundle, nowMs: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(CapstanError);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toMatch(/agent key/);
    expect(http.posts.length).toBe(0); // nothing sent

    // all signed by the owner: posted in order, no retry, agentRef from the agent address
    const good = signAll(bundle);
    const h2 = fixtureHttp(okExchange);
    const res = await submitOnboarding(good, h2, { bundle, nowMs: NOW });
    expect(h2.posts.map((p) => (p.body as { action: { type: string } }).action.type)).toEqual(["approveAgent", "approveBuilderFee"]);
    const first = h2.posts[0]!.body as { action: Record<string, unknown>; nonce: number; signature: { r: string; s: string; v: number }; vaultAddress: null };
    expect(first.action.signatureChainId).toBe("0xa4b1");
    expect(first.action.hyperliquidChain).toBe("Mainnet");
    expect(first.vaultAddress).toBeNull();
    expect([27, 28]).toContain(first.signature.v);
    expect(res.delegation.builderMaxBps).toBe(3);
    expect(res.agentRef).toMatch(/^hl:0x[0-9a-f]{40}$/);
    expect(res.venueResponses.length).toBe(2);

    // a step signed by a third key is refused too
    const third = signAll(bundle, (i) => (i === 1 ? new Uint8Array(32).fill(7) : OWNER_KEY));
    await expect(submitOnboarding(third, fixtureHttp(okExchange), { bundle, nowMs: NOW })).rejects.toThrow(/not signed by the owner/);
    // a venue refusal stops the run and is reported
    let n = 0;
    const h3 = fixtureHttp((b) => (b.__path === "/exchange" ? (n++ === 0 ? { status: "err", response: "Must deposit before performing actions." } : { status: "ok" }) : undefined));
    await expect(submitOnboarding(good, h3, { bundle, nowMs: NOW })).rejects.toThrow(/Must deposit/);
    expect(h3.posts.length).toBe(1);
    // expired bundle, wrong bundle id, missing signature
    await expect(submitOnboarding(good, fixtureHttp(okExchange), { bundle, nowMs: bundle.expiresAt + 1 })).rejects.toThrow(/expired/);
    await expect(submitOnboarding({ ...good, bundleId: "other" }, fixtureHttp(okExchange), { bundle, nowMs: NOW })).rejects.toThrow(/another bundle/);
    await expect(submitOnboarding({ ...good, signatures: good.signatures.slice(0, 2) }, fixtureHttp(okExchange), { bundle, nowMs: NOW })).rejects.toThrow(/not signed/);
    expect(OWNER).toMatch(/^0x/);
  });
});
