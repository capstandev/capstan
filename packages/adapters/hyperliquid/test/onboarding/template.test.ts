// R9: the template hash pins the bundle SHAPE, not the user's values.
import { describe, expect, test } from "bun:test";
import { buildOnboarding, HL_TEMPLATE_VERSION, templateHash } from "../../src";
import { addressOf } from "@capstan/signer-hl";
import { context, DAY, key, NOW, request } from "./util";

describe("template", () => {
  test("shape-hash", async () => {
    expect(HL_TEMPLATE_VERSION).toBe(1);
    const { ctx } = context();
    const a = await buildOnboarding(request(), ctx);
    const other = (l: string) => addressOf(key(l)).toLowerCase() as `0x${string}`;
    const b = await buildOnboarding(request({ owner: other("o2"), agentAddress: other("a2"), agentValidUntilMs: NOW + 30 * DAY, signatureChainId: "0x66eee" }), { ...ctx, nowMs: NOW + 12345 });
    expect(a.templateHash).toBe(b.templateHash);
    expect(templateHash(a)).toBe(a.templateHash);
    // collateral amounts and dex names are values too, but adding the step changes the shape
    const c1 = await buildOnboarding(request({ collateralMoves: [{ toDex: "xyz", token: "USDC", amount: "1" }] }), ctx);
    const c2 = await buildOnboarding(request({ collateralMoves: [{ toDex: "io", token: "USDC", amount: "99" }] }), ctx);
    expect(c1.templateHash).toBe(c2.templateHash);
    expect(c1.templateHash).not.toBe(a.templateHash);
    // removed, re-ordered, changed maxFeeRate, changed signer
    expect(templateHash({ ...a, steps: a.steps.slice(0, 2) })).not.toBe(a.templateHash);
    expect(templateHash({ ...a, steps: [a.steps[0]!, a.steps[2]!, a.steps[1]!] })).not.toBe(a.templateHash);
    const fee = structuredClone(a);
    fee.steps[2]!.typedData!.message.maxFeeRate = "0.05%";
    expect(templateHash(fee)).not.toBe(a.templateHash);
    const signer = structuredClone(a);
    signer.steps[2]!.signer = "delegated_key";
    expect(templateHash(signer)).not.toBe(a.templateHash);
    // network is pinned too (Mainnet vs Testnet are different templates)
    const t = await buildOnboarding(request({ network: "Testnet" }), ctx);
    expect(t.templateHash).not.toBe(a.templateHash);
  });
});
