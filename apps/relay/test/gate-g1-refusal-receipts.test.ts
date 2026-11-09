// Release gate 2026-11-08 G-1: with RECEIPT_SIGNER=none the api and relay queue refusal receipts on the
// receipt-sign-refusal queue. They were added under the job name "receipt-sign", the workers runner dispatches by job
// name and the refusal worker only handles "receipt-sign-refusal", so no refusal was ever signed and each refused
// request waited the full 10 s. This runs the real workers runner (startJobs) with the real receipt jobs on Redis and
// Postgres. Needs DATABASE_URL and REDIS_URL (skips without them).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createRedis, createTempDatabase, devSigner, logger, type Db } from "@capstan/core";
import { refusalReceipt } from "@capstan/eligibility";
import { drafts, verifyReceiptSig } from "@capstan/receipts";
import type { Hex, Receipt } from "@capstan/schema";
import { job as receiptSign } from "../../workers/src/jobs/receipt-sign.job";
import { job as receiptSignRefusal } from "../../workers/src/jobs/receipt-sign-refusal.job";
import { startJobs, type Running } from "../../workers/src/runner";
import * as wire from "../src/wire";

const { queuedReceipts } = wire;
// read off the module so this file still loads (and fails on behaviour) on a tree without the constant
const RECEIPT_JOB_NAMES = (wire as { RECEIPT_JOB_NAMES?: { main: string; refusal: string } }).RECEIPT_JOB_NAMES;

const PG = process.env.DATABASE_URL;
const RD = process.env.REDIS_URL;
const d = PG && RD ? describe : describe.skip;
const OWNER = "0x00000000000000000000000000000000000b0b02" as Hex;
const h32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const SIGNER = devSigner(31337, "capstan-receipt-dev").address as Hex;

d("gate G-1: refusal receipts through the real runner", () => {
  let tmp: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  let running: Running | undefined;
  const conns: ReturnType<typeof createRedis>[] = [];
  const prefix = `gate-g1-${process.pid}-${Date.now()}`;
  const ENV_KEYS = ["RECEIPT_SIGNER", "ANCHOR_SIGNER"] as const;
  const saved = ENV_KEYS.map((k) => process.env[k]);
  const bull = () => {
    const c = createRedis(RD!, { forBullmq: true });
    conns.push(c);
    return c;
  };
  const start = async () => {
    running = await startJobs([receiptSign, receiptSignRefusal], { db, redis: null, cache: null, log: logger("g1", { sink: () => {} }), now: () => new Date() }, bull(), prefix);
  };
  beforeAll(async () => {
    // the receipts process as deployed signs with its keystore; here the workers config takes the 31337 dev keys
    for (const k of ENV_KEYS) process.env[k] = "dev";
    tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_gate_g1" });
    db = createDb(tmp.url, { max: 8 });
  }, 60_000);
  afterAll(async () => {
    await running?.stop();
    const r = createRedis(RD!);
    const keys = await r.keys(`${prefix}:*`);
    if (keys.length) await r.del(...keys);
    r.disconnect();
    conns.forEach((c) => c.disconnect());
    if (db) await closeDb(db);
    await tmp?.drop();
    ENV_KEYS.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }, 60_000);

  test("names: each lane adds jobs under the name its worker handles", () => {
    expect(RECEIPT_JOB_NAMES?.main).toBe(receiptSign.name);
    expect(RECEIPT_JOB_NAMES?.refusal).toBe(receiptSignRefusal.name);
  });

  test("every refusal kind (geo, eligibility, policy, duplicate) gets a signed receipt at once", async () => {
    await start();
    const receipts = queuedReceipts(bull(), db, { prefix });
    const issue = (x: Parameters<typeof receipts.issue>[0]) => receipts.issue(x);
    const geo = { id: "elig-geo-g1", allowed: false, code: "GEO_REFUSED" } as never;
    const decl = { id: "elig-decl-g1", allowed: false, code: "DECLARATION_MISSING" } as never;
    const t0 = Date.now();
    const out: Receipt[] = [
      await refusalReceipt(geo, { route: "/v1/orders/build" }, issue, { owner: OWNER }),
      await refusalReceipt(decl, { route: "/v1/orders/build" }, issue, { owner: OWNER, venue: "hyperliquid" }),
      await issue(drafts.refusal({ requestHash: h32(0x9001), eligibilityDecisionId: "relay:POLICY_BREACH", owner: OWNER, agentRef: "hl:0x00000000000000000000000000000000000a9e01", venue: "hyperliquid", marketId: "hyperliquid:-:BTC" })),
      await issue(drafts.refusal({ requestHash: h32(0x9002), eligibilityDecisionId: "relay:DUPLICATE", owner: OWNER, venue: "hyperliquid" })),
    ];
    // before the fix each one timed out after 10 s with "no handler for job receipt-sign on queue receipt-sign-refusal"
    expect(Date.now() - t0).toBeLessThan(5_000);
    for (const r of out) {
      expect(r.action).toBe("refusal");
      expect(verifyReceiptSig(r, [SIGNER])).toBe(true);
    }
    expect(new Set(out.map((r) => r.receiptId)).size).toBe(4);
  }, 30_000);

  test("a refused request is not held while the refusal worker is busy or down, and the receipt is still signed", async () => {
    await running?.stop();
    running = undefined;
    const receipts = queuedReceipts(bull(), db, { prefix });
    const dr = drafts.refusal({ requestHash: h32(0x9003), eligibilityDecisionId: "relay:GEO_REFUSED", owner: OWNER });
    const t0 = Date.now();
    const err = await receipts.issue(dr).then(() => null, (e: Error) => e);
    // the default refusal wait is short; main waited 10 s here
    expect(err).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(3_000);
    // the job stayed queued: once a worker runs, the same refusal is signed (same job id, idempotent receipt)
    await start();
    const r = await receipts.issue(dr);
    expect(r.action).toBe("refusal");
    expect(verifyReceiptSig(r, [SIGNER])).toBe(true);
  }, 30_000);
});
