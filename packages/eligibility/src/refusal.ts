// Refusal receipts (spec 10, 11): every refused routed action gets a signed `refusal` receipt that carries the
// decision id. The request hash covers the request body and the decision id together, so two identical refused
// requests are two refusals with two receipts (the receipt service is idempotent on request hash + build id).
import { draft, jcs, type ReceiptDraft } from "@capstan/receipts";
import { type ErrorCode, type Hex, type Receipt, type VenueId, ERROR_CODES } from "@capstan/schema";
import { createHash } from "node:crypto";
import type { DecisionCode, EligibilityDecision } from "./decide";

/** Error text per refusal code. GEO_REFUSED says only "Not available in your region." (spec 10 marketing rule). */
export const REFUSAL_TEXT: Record<DecisionCode, string> = {
  GEO_REFUSED: ERROR_CODES.GEO_REFUSED.message,
  DECLARATION_MISSING: ERROR_CODES.DECLARATION_MISSING.message,
  VENUE_DATA_ONLY: ERROR_CODES.VENUE_DATA_ONLY.message,
};

export interface RefusalContext {
  owner?: Hex | null;
  agentRef?: string | null;
  venue?: VenueId | null;
  marketId?: string | null;
}

export function refusalRequestHash(request: unknown, decisionId: string): Hex {
  const body = jcs({ request: request === undefined ? null : request, eligibilityDecisionId: decisionId });
  return `0x${createHash("sha256").update(body).digest("hex")}` as Hex;
}

export async function refusalReceipt(decision: EligibilityDecision, request: unknown, issue: (d: ReceiptDraft) => Promise<Receipt>, ctx: RefusalContext = {}): Promise<Receipt> {
  if (decision.allowed || !decision.code) throw new Error("refusalReceipt: the decision is not a refusal");
  const d = draft("refusal", {
    requestHash: refusalRequestHash(request, decision.id),
    eligibilityDecisionId: decision.id,
    owner: ctx.owner ? (ctx.owner.toLowerCase() as Hex) : null,
    agentRef: ctx.agentRef ?? null,
    venue: ctx.venue ?? null,
    marketId: ctx.marketId ?? null,
  });
  return issue(d);
}

export function refusalBody(code: DecisionCode, receiptId?: string): { error: { code: ErrorCode; message: string; receiptId?: string } } {
  const body: { error: { code: ErrorCode; message: string; receiptId?: string } } = { error: { code, message: REFUSAL_TEXT[code] } };
  if (receiptId) body.error.receiptId = receiptId;
  return body;
}
