// Shape check for a receipt draft that arrives over a queue (receipt-sign workers and the relay's receipt retry).
import { RECEIPT_ACTIONS } from "@capstan/schema";
import type { ReceiptDraft } from "./chain";

export function validateDraft(d: unknown): ReceiptDraft {
  const x = d as Partial<ReceiptDraft> | null;
  if (!x || typeof x !== "object") throw new Error("receipt-sign: job data.draft is not an object");
  if (!RECEIPT_ACTIONS.includes(x.action as (typeof RECEIPT_ACTIONS)[number])) throw new Error("receipt-sign: unknown action");
  if (typeof x.requestHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(x.requestHash)) throw new Error("receipt-sign: requestHash must be 32 bytes");
  if (x.owner !== null && (typeof x.owner !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(x.owner))) throw new Error("receipt-sign: owner must be an address or null");
  if (typeof x.eligibilityDecisionId !== "string") throw new Error("receipt-sign: eligibilityDecisionId is required");
  return x as ReceiptDraft;
}
