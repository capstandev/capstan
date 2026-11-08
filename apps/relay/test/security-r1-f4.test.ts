// Security review r1, review-r1:6 F4: refusal receipts (any stranger can trigger them) must not starve order receipts.
// A backlog of refusals sits on its own queue with its own worker, so an order receipt is signed at once.
// Needs DATABASE_URL and REDIS_URL (skips without them).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createRedis, createTempDatabase, QUEUES, type Db } from "@capstan/core";
import { createReceiptService, drafts, nobleSigner } from "@capstan/receipts";
import type { Hex } from "@capstan/schema";
import { Worker } from "bullmq";
import { queuedReceipts } from "../src/wire";
import { testKey } from "./helpers";

const PG = process.env.DATABASE_URL;
const RD = process.env.REDIS_URL;
const d = PG && RD ? describe : describe.skip;
const OWNER = "0x00000000000000000000000000000000000b0b01" as Hex;
const h32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

d("security r1 F4", () => {
  let tmp: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  const workers: Worker[] = [];
  const conns: ReturnType<typeof createRedis>[] = [];
  const prefix = `sec-f4-${Date.now()}`;
  beforeAll(async () => {
    tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_sec_f4" });
    db = createDb(tmp.url, { max: 8 });
  }, 60_000);
  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close(true)));
    const r = createRedis(RD!);
    const keys = await r.keys(`${prefix}:*`);
    if (keys.length) await r.del(...keys);
    r.disconnect();
    conns.forEach((c) => c.disconnect());
    if (db) await closeDb(db);
    await tmp?.drop();
  }, 60_000);

  test("refusal-backlog-cannot-starve-order-receipts", async () => {
    const svc = createReceiptService({ db, signer: nobleSigner(testKey("f4-receipt-signer")), now: () => new Date() });
    // the receipt-sign worker as deployed: concurrency 4, each signature takes a few ms
    const handler = async (j: { data: { draft: Parameters<typeof svc.issue>[0] } }) => {
      await Bun.sleep(20);
      return { receiptId: (await svc.issue(j.data.draft)).receiptId };
    };
    const queues = [QUEUES.receiptSign, (QUEUES as Record<string, string>).receiptSignRefusal].filter((q): q is string => typeof q === "string");
    for (const q of queues) {
      const c = createRedis(RD!, { forBullmq: true });
      conns.push(c);
      workers.push(new Worker(q, handler as never, { connection: c, prefix, concurrency: q === QUEUES.receiptSign ? 4 : 1 }));
    }
    const bull = createRedis(RD!, { forBullmq: true });
    conns.push(bull);
    const receipts = queuedReceipts(bull, db, { prefix, waitMs: 3_000 });
    // a stranger floods refusals for the owner (fire and forget, as the api edge does under load)
    for (let i = 0; i < 2000; i++) void receipts.issue(drafts.refusal({ requestHash: h32(i + 1), eligibilityDecisionId: "elig-flood", owner: OWNER })).catch(() => undefined);
    await Bun.sleep(300);
    const t0 = Date.now();
    const r = await receipts.issue(drafts.orderSubmit({ requestHash: h32(999_999), eligibilityDecisionId: "elig-ok", owner: OWNER, venue: "hyperliquid", marketId: "hyperliquid:-:BTC", buildId: "build-f4", signedPayloadHash: h32(424242) }));
    expect(r.action).toBe("order.submit");
    expect(Date.now() - t0).toBeLessThan(2_000);
  }, 60_000);
});
