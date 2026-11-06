// R13 (todo 14): revocation = DelAgent + DelBuilder, both main-wallet Mode A.
import { mgmtTypeString } from "@capstan/signer-aster";
import { AsterNonce } from "@capstan/signer-aster";
import { describe, expect, test } from "bun:test";
import type { AsterVenueTx } from "../../src/onboarding";
import { buildRevocation } from "../../src/revocation";
import { AGENT, BUILDER, NOW, OWNER } from "./fixtures";

describe("aster revocation", () => {
  test("del-agent-builder", () => {
    const b = buildRevocation(OWNER, AGENT, { builder: BUILDER, nonce: new AsterNonce(), network: "Testnet", nowMs: NOW });
    expect(b.steps.map((s) => s.kind)).toEqual(["revoke_agent", "revoke_builder"]);
    expect(b.steps.every((s) => s.signer === "main_wallet")).toBe(true);
    expect(b.steps.map((s) => s.typedData!.primaryType)).toEqual(["DelAgent", "DelBuilder"]);
    expect(b.steps.every((s) => s.typedData!.domain.chainId === 56)).toBe(true);
    const [a, d] = b.steps.map((s) => s.venueTx as AsterVenueTx);
    expect([a!.method, a!.path]).toEqual(["DELETE", "/fapi/v3/agent"]);
    expect([d!.method, d!.path]).toEqual(["DELETE", "/fapi/v3/builder"]);
    expect(mgmtTypeString(b.steps[0]!.typedData!)).toBe("DelAgent(string AgentAddress,string AsterChain,string User,uint256 Nonce)");
    expect(mgmtTypeString(b.steps[1]!.typedData!)).toBe("DelBuilder(string Builder,string AsterChain,string User,uint256 Nonce)");
    expect(b.steps[0]!.typedData!.message).toMatchObject({ AgentAddress: AGENT, AsterChain: "Testnet", User: OWNER });
    expect(b.steps[1]!.typedData!.message).toMatchObject({ Builder: BUILDER, User: OWNER });
    expect(Number(b.steps[1]!.typedData!.message.Nonce)).toBeGreaterThan(Number(b.steps[0]!.typedData!.message.Nonce));
    expect(() => buildRevocation("0xnope" as never, AGENT, { builder: BUILDER, nonce: new AsterNonce(), network: "Testnet", nowMs: NOW })).toThrow();
  });
});
