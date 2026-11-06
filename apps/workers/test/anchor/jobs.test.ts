// The three drop-in jobs: discovered by the runner, scheduled as the spec says, and receipt-sign is idempotent.
import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, logger, schema, type JobDeps } from "@capstan/core";
import type { Job } from "bullmq";
import { draft } from "../../../../packages/receipts/test/pg/draft";
import { job as indexerJob } from "../../src/jobs/root-indexer.job";
import { job as signJob, validateDraft } from "../../src/jobs/receipt-sign.job";
import { discoverJobs } from "../../src/runner";
import { PG, T } from "./fixture";

describe("anchor and receipt jobs", () => {
  test("definitions", async () => {
    const names = (await discoverJobs()).map((j) => j.name);
    for (const n of ["merkle-anchor", "receipt-sign", "root-indexer"]) expect(names).toContain(n);
    expect(indexerJob).toMatchObject({ queue: "anchorHourly", schedule: { every: 300_000 }, concurrency: 1 });
    expect(signJob).toMatchObject({ queue: "receiptSign", concurrency: 4 });
    expect(signJob.schedule).toBeUndefined();
  });

  test("validateDraft refuses malformed drafts", () => {
    expect(validateDraft(draft(null, 1))).toBeDefined();
    expect(() => validateDraft(null)).toThrow();
    expect(() => validateDraft({ ...draft(null, 1), action: "withdraw" })).toThrow(/unknown action/);
    expect(() => validateDraft({ ...draft(null, 1), requestHash: "0x12" })).toThrow(/32 bytes/);
    expect(() => validateDraft({ ...draft(null, 1), owner: "bob" })).toThrow(/owner/);
  });
});

(PG ? describe : describe.skip)("receipt-sign handler", () => {
  let drop: (() => Promise<void>) | null = null;
  afterAll(() => drop?.(), T);
  test(
    "a redelivered job returns the first receipt",
    async () => {
      const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_rsj" });
      const db = createDb(t.url, { max: 4 });
      drop = async () => {
        await closeDb(db);
        await t.drop();
      };
      const saved = { ...process.env };
      Object.assign(process.env, { RECEIPT_SIGNER: "dev", ANCHOR_SIGNER: "dev", REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:1" });
      try {
        const published: string[] = [];
        const deps: JobDeps = { db, redis: null, cache: null, log: logger("test", { sink: () => {} }), now: () => new Date(), publish: async (c) => void published.push(c) };
        const data = { draft: draft("0x00000000000000000000000000000000000000dd", 5) };
        const a = (await signJob.handler({ data } as Job, deps)) as { receiptId: string };
        const b = (await signJob.handler({ data } as Job, deps)) as { receiptId: string };
        expect(b.receiptId).toBe(a.receiptId);
        expect((await db.select().from(schema.receipts)).length).toBe(1);
        expect(published).toEqual(["ps:receipts:0x00000000000000000000000000000000000000dd"]);
      } finally {
        process.env = saved;
      }
    },
    T,
  );
});
