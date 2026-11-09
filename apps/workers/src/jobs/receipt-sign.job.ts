// receipt-sign (spec 9): consumes receipt-sign jobs from the relay and the API and issues each receipt through the
// receipt service. One owner's receipts are appended one at a time across every worker process (a Postgres advisory
// lock plus SELECT ... FOR UPDATE on the owner's chain head), so the job can run with concurrency > 1. A redelivered
// job returns the first receipt: requestHash + buildId is the idempotency key.
import { loadConfig, type JobDef, type JobDeps } from "@capstan/core";
import { createReceiptService, validateDraft, type ReceiptService } from "@capstan/receipts";
import { loadServiceSigner } from "../anchor/context";

export { validateDraft };

// one service per database handle: a process that runs the job against a second handle (a new pool, a test) never
// signs through a service bound to a closed one
const services = new WeakMap<object, Promise<ReceiptService>>();
const serviceFor = (deps: JobDeps): Promise<ReceiptService> => {
  if (!deps.db) return makeService(deps);
  const hit = services.get(deps.db);
  if (hit) return hit;
  const p = makeService(deps).catch((e) => (deps.db && services.delete(deps.db), Promise.reject(e)));
  services.set(deps.db, p);
  return p;
};
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
    const s = await serviceFor(deps);
    const r = await s.issue(draft);
    return { receiptId: r.receiptId };
  },
};
