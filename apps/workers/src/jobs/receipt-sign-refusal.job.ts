// receipt-sign-refusal (security r1 F4): the same signing as receipt-sign, for refusal receipts only. Anyone can
// trigger a refusal, so refusals get their own queue and a small worker of their own: a flood of them waits here and
// never holds a slot an order, claim or kill receipt needs. Runs in the receipts process (same keystore).
import type { JobDef } from "@capstan/core";
import { job as receiptSign } from "./receipt-sign.job";

export const job: JobDef = {
  name: "receipt-sign-refusal",
  queue: "receiptSignRefusal",
  concurrency: 2,
  handler: receiptSign.handler,
};
