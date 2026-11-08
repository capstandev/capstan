// receipt-sign (spec 9): consumes receipt-sign jobs from the relay and the API and issues each receipt through the
// receipt service. One owner's receipts are appended one at a time across every worker process (a Postgres advisory
// lock plus SELECT ... FOR UPDATE on the owner's chain head), so the job can run with concurrency > 1. A redelivered
// job returns the first receipt: requestHash + buildId is the idempotency key.
import { loadConfig, type JobDef, type JobDeps } from "@capstan/core";
import { createReceiptService, validateDraft, type ReceiptService } from "@capstan/receipts";
import { loadServiceSigner } from "../anchor/context";

export { validateDraft };

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
