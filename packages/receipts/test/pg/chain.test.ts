// R1: 50 concurrent issue calls for one owner give one linear chain and 50 rows; different owners run in parallel.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, devSigner, schema, type Db } from "@capstan/core";
import { type Hex } from "@capstan/schema";
import { eq, sql } from "drizzle-orm";
import { createReceiptService, receiptHash, verifyChain } from "../../src";
import { draft } from "./draft";

const PG = process.env.DATABASE_URL;
const T = 30_000;


(PG ? describe : describe.skip)("pg receipt chain", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_rc" });
    db = createDb(t.url, { max: 20 });
    drop = async () => {
      await closeDb(db);
      await t.drop();
    };
  }, T);
  afterAll(() => drop?.(), T);

  test(
    "concurrent-owner-linear",
    async () => {
      const svc = createReceiptService({ db, signer: devSigner(31337, "rc-chain"), now: () => new Date() });
      const owner = "0x00000000000000000000000000000000000000aa" as Hex;
      const out = await Promise.all(Array.from({ length: 50 }, (_, i) => svc.issue(draft(owner, i))));
      expect(new Set(out.map((r) => r.receiptId)).size).toBe(50);
      const rows = await db.select().from(schema.receipts).where(eq(schema.receipts.owner, owner));
      expect(rows.length).toBe(50);
      const bodies = await Promise.all(out.map((r) => svc.get(r.receiptId)));
      expect(verifyChain(bodies.map((b) => b!))).toEqual({ ok: true });
      // linear: exactly one receipt starts the chain, and every hash is the parent of at most one receipt
      const parents = bodies.map((b) => b!.prevReceiptHash);
      expect(parents.filter((p) => p === null).length).toBe(1);
      expect(new Set(parents).size).toBe(50);
      const hashes = new Set(bodies.map((b) => receiptHash(b!)));
      for (const p of parents) if (p !== null) expect(hashes.has(p)).toBe(true);
      const head = await db.select().from(schema.receiptHeads).where(eq(schema.receiptHeads.owner, owner));
      const tip = bodies.find((b) => !parents.includes(receiptHash(b!)))!;
      expect(head[0]!.lastReceiptId).toBe(tip.receiptId);

      // another owner is not blocked while this owner's lock is held
      const reserved = await db.$client.reserve();
      await reserved.unsafe("BEGIN");
      await reserved.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`receipt-owner:${owner}`]);
      let aDone = false;
      const a = svc.issue(draft(owner, 999)).then(() => (aDone = true));
      const b = await svc.issue(draft("0x00000000000000000000000000000000000000bb", 1000));
      expect(b.prevReceiptHash).toBeNull();
      await Bun.sleep(200);
      expect(aDone).toBe(false); // still waiting on the held owner lock
      await reserved.unsafe("COMMIT");
      reserved.release();
      await a;
      expect(aDone).toBe(true);
      const n = await db.execute(sql`select count(*)::int as n from receipts`);
      expect((n as unknown as { n: number }[])[0]!.n).toBe(52);
    },
    T,
  );
});
