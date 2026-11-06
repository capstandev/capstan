// receipt-sign (spec 9): consumes receipt-sign jobs from the relay and the API and issues each receipt through the
// receipt service. One owner's receipts are appended one at a time across every worker process (a Postgres advisory
// lock plus SELECT ... FOR UPDATE on the owner's chain head), so the job can run with concurrency > 1. A redelivered
// job returns the first receipt: requestHash + buildId is the idempotency key.
import { loadConfig, type JobDef, type JobDeps } from "@capstan/core";
import { createReceiptService, type ReceiptDraft, type ReceiptService } from "@capstan/receipts";
import { RECEIPT_ACTIONS } from "@capstan/schema";
import { loadServiceSigner } from "../anchor/context";

export function validateDraft(d: unknown): ReceiptDraft {
  const x = d as Partial<ReceiptDraft> | null;
  if (!x || typeof x !== "object") throw new Error("receipt-sign: job data.draft is not an object");
  if (!RECEIPT_ACTIONS.includes(x.action as (typeof RECEIPT_ACTIONS)[number])) throw new Error("receipt-sign: unknown action");
  if (typeof x.requestHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(x.requestHash)) throw new Error("receipt-sign: requestHash must be 32 bytes");
  if (x.owner !== null && (typeof x.owner !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(x.owner))) throw new Error("receipt-sign: owner must be an address or null");
  if (typeof x.eligibilityDecisionId !== "string") throw new Error("receipt-sign: eligibilityDecisionId is required");
  return x as ReceiptDraft;
}

let svc: Promise<ReceiptService> | null = null;
async function makeService(deps: JobDeps): Promise<ReceiptService> {
  if (!deps.db) throw new Error("receipt-sign needs a database");
  const signer = await loadServiceSigner(loadConfig("workers"), "RECEIPT");
  return createReceiptService({ db: deps.db, signer, now: deps.now, publish: deps.publish });
}

export const job: JobDef = {
  name: "receipt-sign",
  queue: "receiptSign",
  concurrency: 4,
  async handler(j, deps) {
    const draft = validateDraft((j.data as { draft?: unknown })?.draft);
    const s = await (svc ??= makeService(deps).catch((e) => ((svc = null), Promise.reject(e))));
    const r = await s.issue(draft);
    return { receiptId: r.receiptId };
  },
};
