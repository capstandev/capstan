// R3, R5, R6, R8, R12, R13: the bundle the main wallet signs.
import { describe, expect, test } from "bun:test";
import { hashTypedPayload, parseAgentName, userSignedDigest } from "@capstan/signer-hl";
import { approveAgentStep, approveBuilderFeeStep, assertHasBuilderApproval, buildOnboarding, capstanAgentName } from "../../src";
import { HL_VECTORS } from "../../../../signers/hl/test/vectors/hl";
import { BUILDER } from "../helpers";
import { AGENT, context, DAY, NOW, OWNER, request } from "./util";

describe("build", () => {
  test("builder-step-mandatory", async () => {
    const { ctx } = context();
    const b = await buildOnboarding(request(), ctx);
    const kinds = b.steps.map((s) => s.kind);
    expect(kinds).toEqual(["eligibility_declaration", "hl_approve_agent", "hl_approve_builder_fee"]);
    const builder = b.steps[2]!;
    expect(builder.signer).toBe("main_wallet");
    expect(builder.typedData!.message.maxFeeRate).toBe("0.03%");
    expect(builder.typedData!.message.builder).toBe(BUILDER);
    expect(builder.typedData!.primaryType).toBe("HyperliquidTransaction:ApproveBuilderFee");
    for (const bps of [4, 10, 3.5]) await expect(buildOnboarding(request({ builderMaxBps: bps }), ctx)).rejects.toThrow(/3 bps/);
    await expect(buildOnboarding(request({ builderMaxBps: undefined as never }), ctx)).rejects.toThrow();
    // a step list without the builder approval is refused
    expect(() => assertHasBuilderApproval(b.steps.filter((s) => s.kind !== "hl_approve_builder_fee"))).toThrow(/builder approval/);
    expect(() => assertHasBuilderApproval(b.steps.map((s) => (s.kind === "hl_approve_builder_fee" ? { ...s, signer: "delegated_key" as const } : s)))).toThrow();
    expect(b.humanReadable.length).toBe(b.steps.length);
    expect(b.humanReadable[2]).toBe(`Allow Capstan to charge up to 0.03% per trade on Hyperliquid (builder ${BUILDER}).`);
    expect(b.owner).toBe(OWNER);
    expect(b.expiresAt).toBeGreaterThan(NOW);
  });

  test("named-agent", async () => {
    const { ctx } = context();
    const b = await buildOnboarding(request(), ctx);
    const name = b.steps[1]!.typedData!.message.agentName as string;
    expect(name).toMatch(/^cpst-[a-z2-7]{6} valid_until \d+$/);
    expect(parseAgentName(name).name).toBe(capstanAgentName(AGENT));
    expect((b.steps[1]!.venueTx as { action: Record<string, unknown> }).action.agentName).toBe(name);
    expect(b.steps[1]!.typedData!.message.agentAddress).toBe(AGENT);
    // deterministic from the address, different for another address
    expect(capstanAgentName(AGENT)).toBe(capstanAgentName(AGENT.toUpperCase().replace("0X", "0x") as `0x${string}`));
    expect(capstanAgentName("0x00000000000000000000000000000000a9e17001")).not.toBe(capstanAgentName(AGENT));
    expect(b.humanReadable[1]).toBe(`Allow agent ${capstanAgentName(AGENT)} (${AGENT.slice(0, 6)}...${AGENT.slice(-4)}) to trade on Hyperliquid until ${new Date(NOW + 90 * DAY).toISOString().slice(0, 10)}. It cannot withdraw.`);
    // reusing an agent address is refused
    const { ctx: c2 } = context(undefined, { agentSeenBefore: () => true });
    await expect(buildOnboarding(request(), c2)).rejects.toThrow(/used before/);
  });

  test("expiry-cap", async () => {
    const { ctx } = context();
    const at = (b: Awaited<ReturnType<typeof buildOnboarding>>) => parseAgentName(b.steps[1]!.typedData!.message.agentName as string).validUntil!;
    expect(at(await buildOnboarding(request({ agentValidUntilMs: NOW + 180 * DAY }), ctx))).toBe(NOW + 180 * DAY);
    await expect(buildOnboarding(request({ agentValidUntilMs: NOW + 180 * DAY + 1 }), ctx)).rejects.toThrow(/180 days/);
    await expect(buildOnboarding(request({ agentValidUntilMs: NOW - 1 }), ctx)).rejects.toThrow();
    // default: the policy expiry, else 90 days
    expect(at(await buildOnboarding(request({ agentValidUntilMs: undefined }), ctx))).toBe(NOW + 90 * DAY);
    expect(at(await buildOnboarding(request({ agentValidUntilMs: undefined, expiresAt: NOW + 7 * DAY }), ctx))).toBe(NOW + 7 * DAY);
  });

  test("builder-not-owner", async () => {
    const { ctx } = context();
    await expect(buildOnboarding(request({ owner: BUILDER }), ctx)).rejects.toThrow(/builder wallet/);
    await expect(buildOnboarding(request({ owner: BUILDER.toUpperCase().replace("0X", "0x") as `0x${string}` }), ctx)).rejects.toThrow(/builder wallet/);
    await expect(buildOnboarding(request({ agentAddress: BUILDER }), ctx)).rejects.toThrow(/fresh key/);
    await expect(buildOnboarding(request({ agentAddress: OWNER }), ctx)).rejects.toThrow(/fresh key/);
  });

  test("matches-vectors", async () => {
    const vec = (n: string) => HL_VECTORS.userSigned.find((v) => v.name === n)!;
    const va = vec("cpst_approve_agent_named_validuntil_mainnet");
    const m = va.message as Record<string, any>;
    const step = approveAgentStep({ network: "Mainnet", signatureChainId: m.signatureChainId, nonce: m.nonce, agentAddress: m.agentAddress, agentName: m.agentName });
    expect(hashTypedPayload(step.typedData!)).toBe(va.eip712Digest as `0x${string}`);
    expect(step.typedData!.primaryType).toBe(va.primaryType);
    expect(step.typedData!.types[va.primaryType]).toEqual(va.types as never);
    expect(step.typedData!.domain).toEqual(va.domain as never);
    const vb = vec("cpst_approve_builder_fee_0.03pct_mainnet");
    const mb = vb.message as Record<string, any>;
    const sb = approveBuilderFeeStep({ network: "Mainnet", signatureChainId: mb.signatureChainId, nonce: mb.nonce, builder: mb.builder, maxFeeRate: mb.maxFeeRate });
    expect(hashTypedPayload(sb.typedData!)).toBe(vb.eip712Digest as `0x${string}`);
    expect(sb.typedData!.types[vb.primaryType]).toEqual(vb.types as never);
    // the built bundle uses exactly the same struct shapes
    const { ctx } = context();
    const b = await buildOnboarding(request({ signatureChainId: "0x66eee" }), ctx);
    expect(b.steps[1]!.typedData!.types[va.primaryType]).toEqual(va.types as never);
    expect(b.steps[2]!.typedData!.types[vb.primaryType]).toEqual(vb.types as never);
    expect(b.steps[1]!.typedData!.domain).toEqual(va.domain as never);
    expect(hashTypedPayload(b.steps[2]!.typedData!)).toBe(userSignedDigest({ type: "approveBuilderFee", hyperliquidChain: "Mainnet", signatureChainId: "0x66eee", maxFeeRate: "0.03%", builder: BUILDER, nonce: b.steps[2]!.typedData!.message.nonce as number }));
  });

  test("no-withdraw-grant", async () => {
    const { ctx } = context();
    const b = await buildOnboarding(request({ collateralMoves: [{ toDex: "xyz", token: "USDC", amount: "25" }] }), ctx);
    const json = JSON.stringify(b);
    const hits = json.match(/withdraw/gi) ?? [];
    expect(hits.length).toBe(1);
    expect(json).toContain("It cannot withdraw.");
    for (const s of b.steps) expect(["eligibility_declaration", "hl_approve_agent", "hl_approve_builder_fee", "hl_collateral_move", "agent_policy"]).toContain(s.kind);
  });
});
