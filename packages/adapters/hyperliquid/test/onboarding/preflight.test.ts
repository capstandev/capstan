// R1, R2: slot and builder-approval limits.
import { describe, expect, test } from "bun:test";
import { buildOnboarding, HlOnboardingError, preflight } from "../../src";
import { BUILDER, fx } from "../helpers";
import { context, NOW, OWNER, request } from "./util";

const tenBuilders = Array.from({ length: 10 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);

describe("preflight", () => {
  test("slots-full", async () => {
    const three = fx("extraAgents_userA").slice(0, 3);
    const { ctx, reader } = context((b) => (b.type === "extraAgents" ? three : undefined));
    const pf = await preflight(reader, OWNER, BUILDER, NOW);
    expect(pf.namedAgents.length).toBe(3);
    expect(pf.slotsFree).toBe(0);
    const err = await buildOnboarding(request(), ctx).catch((e) => e);
    expect(err).toBeInstanceOf(HlOnboardingError);
    expect(err.code).toBe("HL_AGENT_SLOTS_FULL");
    expect(err.help).toMatch(/remove an agent/);
    // two named agents leave one slot
    const { ctx: c2, reader: r2 } = context((b) => (b.type === "extraAgents" ? three.slice(0, 2) : undefined));
    expect((await preflight(r2, OWNER, BUILDER, NOW)).slotsFree).toBe(1);
    await expect(buildOnboarding(request(), c2)).resolves.toBeDefined();
    // an expired agent frees its slot
    const expired = three.map((a: { validUntil: number }, i: number) => (i === 0 ? { ...a, validUntil: NOW - 1 } : a));
    const { reader: r3 } = context((b) => (b.type === "extraAgents" ? expired : undefined));
    expect((await preflight(r3, OWNER, BUILDER, NOW)).slotsFree).toBe(1);
  });

  test("approvals-full", async () => {
    const { ctx, reader } = context((b) => (b.type === "approvedBuilders" ? tenBuilders : b.type === "maxBuilderFee" ? 0 : undefined));
    const pf = await preflight(reader, OWNER, BUILDER, NOW);
    expect(pf.approvalsCount).toBe(10);
    expect(pf.approvalsFull).toBe(true);
    expect(pf.builderApprovedTenthsBp).toBe(0);
    expect(pf.depositRequired).toBe(false);
    const err = await buildOnboarding(request(), ctx).catch((e) => e);
    expect(err).toBeInstanceOf(HlOnboardingError);
    expect(err.code).toBe("HL_BUILDER_APPROVALS_FULL");
    expect(err.help).toMatch(/Revoke a builder approval/);
    // our builder among the ten: passes
    const withOurs = [...tenBuilders.slice(0, 9), BUILDER];
    const { ctx: c2 } = context((b) => (b.type === "approvedBuilders" ? withOurs : b.type === "maxBuilderFee" ? 30 : undefined));
    const bundle = await buildOnboarding(request(), c2);
    expect(bundle.steps.some((s) => s.kind === "hl_approve_builder_fee")).toBe(true);
  });
});
