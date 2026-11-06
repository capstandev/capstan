// R12 (todo 14): the -5050 deposit gate flags the user and still lets both approvals be built.
import { describe, expect, test } from "bun:test";
import { buildOnboarding } from "../../src/onboarding";
import { ASTER_DEPOSIT_TEXT, isDepositRequiredBody, preflight, type BuilderReportsClient } from "../../src/preflight";
import { AGENT, ctx, OWNER, req } from "./fixtures";

const gate = { code: -5050, msg: "This function can only be used after deposit" };

describe("aster preflight", () => {
  test("deposit-gate", async () => {
    // the user's own signed read answered -5050
    const a = await preflight(OWNER, { signedRead: { httpStatus: 400, body: gate } });
    expect(a).toMatchObject({ depositRequired: true, code: "ASTER_DEPOSIT_REQUIRED", approvalsAllowed: true });
    // the builder report errors[] text gives the same answer without the user's key
    const reports: BuilderReportsClient = {
      approval: async () => ({ maxFeeRate: "0.0003" }),
      userErrors: async () => [ASTER_DEPOSIT_TEXT],
    };
    const b = await preflight(OWNER, { builderReports: reports });
    expect(b).toMatchObject({ depositRequired: true, code: "ASTER_DEPOSIT_REQUIRED", builderApprovedRate: "0.0003" });
    // approvals are exempt: the bundle still builds with both main-wallet steps
    const bundle = buildOnboarding(req(), ctx());
    expect(bundle.steps.map((s) => s.kind)).toEqual(["eligibility_declaration", "aster_approve_agent", "aster_approve_builder"]);
    // a normal answer clears the gate; no data stays unknown
    const c = await preflight(OWNER, { signedRead: { httpStatus: 200, body: [{ agentAddress: AGENT, canWithdraw: false }] }, agentAddress: AGENT });
    expect(c).toMatchObject({ depositRequired: false, agentExists: true });
    expect(c.code).toBeUndefined();
    expect(await preflight(OWNER, {})).toMatchObject({ depositRequired: "unknown", agentExists: "unknown", builderApprovedRate: null });
    expect(await preflight(OWNER, { signedRead: { httpStatus: 400, body: { code: -1000, msg: "No agent found" } } })).toMatchObject({ agentExists: false, depositRequired: "unknown" });
    // no approval yet: the report cannot speak for this user
    const none = await preflight(OWNER, { builderReports: { approval: async () => null, userErrors: async () => [ASTER_DEPOSIT_TEXT] } });
    expect(none).toMatchObject({ depositRequired: "unknown", builderApprovedRate: null });
    expect(isDepositRequiredBody(gate)).toBe(true);
    expect(isDepositRequiredBody({ code: "-5050" })).toBe(true);
    expect(isDepositRequiredBody(`{"code":-5050}`)).toBe(false);
    expect(isDepositRequiredBody("error: This function can only be used after deposit")).toBe(true);
    expect(isDepositRequiredBody({ code: -1121 })).toBe(false);
  });
});
