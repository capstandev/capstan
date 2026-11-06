// Onboarding preflight (spec 4.4 step 1, venue-aster.md section 6). Since 2026-09-01, authenticated account, order and
// trade endpoints answer -5050 "This function can only be used after deposit" until the main wallet has deposited.
// Agent and builder approvals are exempt, so a missing deposit never blocks onboarding: it only flags the user.
// Sources, in order: the result of a signed read the user's own signer made (SDK side), then the builder report rows
// for that user (only once the user has approved our builder). Capstan never reads the user's account with a key it
// holds (DECISIONS #33).
import type { Hex } from "@capstan/schema";

export const ASTER_DEPOSIT_TEXT = "This function can only be used after deposit";
export const ASTER_DEPOSIT_CODE = -5050;

/** Narrow port onto the builder report endpoints (todo 27 implements it with the builder's own read agent). */
export interface BuilderReportsClient {
  /** The user's approval of our builder, if any (approvedUserList). */
  approval(owner: Hex): Promise<{ maxFeeRate: string } | null>;
  /** Per-address errors[] text the report endpoints return for this user. */
  userErrors(owner: Hex): Promise<string[]>;
  /** Agents registered for the user, when the report exposes them; undefined when unknown. */
  agents?(owner: Hex): Promise<Hex[] | undefined>;
}

/** What the SDK saw when its own signer made a signed read (GET /fapi/v3/agent or an account read). */
export interface SignedReadOutcome {
  httpStatus: number;
  body: unknown;
}

export interface PreflightResult {
  depositRequired: boolean | "unknown";
  builderApprovedRate: string | null;
  agentExists: boolean | "unknown";
  code?: "ASTER_DEPOSIT_REQUIRED";
  /** Agent and builder approvals can always be built (the venue exempts them from the deposit gate). */
  approvalsAllowed: true;
}

export function isDepositRequiredBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return typeof body === "string" && body.includes(ASTER_DEPOSIT_TEXT);
  const b = body as { code?: unknown; msg?: unknown };
  return Number(b.code) === ASTER_DEPOSIT_CODE || (typeof b.msg === "string" && b.msg.includes(ASTER_DEPOSIT_TEXT));
}

export async function preflight(
  owner: Hex,
  ctx: { builderReports?: BuilderReportsClient; signedRead?: SignedReadOutcome; agentAddress?: Hex },
): Promise<PreflightResult> {
  let deposit: boolean | "unknown" = "unknown";
  let agentExists: boolean | "unknown" = "unknown";
  let rate: string | null = null;

  if (ctx.signedRead) {
    const { httpStatus, body } = ctx.signedRead;
    if (isDepositRequiredBody(body)) deposit = true;
    else if (httpStatus >= 200 && httpStatus < 300) {
      deposit = false; // an account read that answered normally means the gate is open
      if (ctx.agentAddress && Array.isArray(body)) {
        agentExists = body.some((a) => String((a as { agentAddress?: unknown }).agentAddress ?? "").toLowerCase() === ctx.agentAddress!.toLowerCase());
      }
    } else if ((body as { code?: unknown } | null)?.code !== undefined && Number((body as { code: unknown }).code) === -1000) {
      agentExists = false; // "No agent found"
    }
  }

  if (ctx.builderReports) {
    const approval = await ctx.builderReports.approval(owner);
    rate = approval?.maxFeeRate ?? null;
    if (approval) {
      const errs = await ctx.builderReports.userErrors(owner);
      if (errs.some((e) => e.includes(ASTER_DEPOSIT_TEXT))) deposit = true;
      else if (deposit === "unknown") deposit = false;
    }
    if (ctx.agentAddress && ctx.builderReports.agents) {
      const agents = await ctx.builderReports.agents(owner);
      if (agents) agentExists = agents.some((a) => a.toLowerCase() === ctx.agentAddress!.toLowerCase());
    }
  }

  return {
    depositRequired: deposit,
    builderApprovedRate: rate,
    agentExists,
    ...(deposit === true ? { code: "ASTER_DEPOSIT_REQUIRED" as const } : {}),
    approvalsAllowed: true,
  };
}
