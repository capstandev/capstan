// R2 idempotent issue, R11 the served proof verifies on the anvil contract, and the receipts channel is published
// only after the row commits.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, devSigner, PUBSUB, schema, type Db } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { eq } from "drizzle-orm";
import { createReceiptService, receiptHash, type ReceiptService } from "../src";
import { ANVIL_URL, anvilClient, deployAnchor, hourOf, postRootDirect, posterFor } from "./anvil";
import { draft } from "./pg/draft";

const PG = process.env.DATABASE_URL;
const T = 60_000;

(PG ? describe : describe.skip)("receipt service", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_rs" });
    db = createDb(t.url, { max: 10 });
    drop = async () => {
      await closeDb(db);
      await t.drop();
    };
  }, T);
  afterAll(() => drop?.(), T);

  test(
    "idempotent",
    async () => {
      const published: [string, unknown][] = [];
      const svc = createReceiptService({ db, signer: devSigner(31337, "rs"), now: () => new Date(), publish: async (c, p) => void published.push([c, p]) });
      const owner = "0x00000000000000000000000000000000000000Cc" as Hex;
      const a = await svc.issue(draft(owner, 1));
      const b = await svc.issue(draft(owner, 1));
      expect(b).toEqual(a);
      expect(published).toEqual([[PUBSUB.receipts(owner.toLowerCase()), { receiptId: a.receiptId }]]);
      // same requestHash, different buildId: a new receipt chained after the first
      const c = await svc.issue(draft(owner, 1, { buildId: "b_other" }));
      expect(c.receiptId).not.toBe(a.receiptId);
      expect(c.prevReceiptHash).toBe(receiptHash(a));
      // buildId null counts as its own key
      const d1 = await svc.issue(draft(owner, 1, { buildId: null }));
      const d2 = await svc.issue(draft(owner, 1, { buildId: null }));
      expect(d2.receiptId).toBe(d1.receiptId);
      // owner-null receipts racing on one key: one row, both callers get it
      const [x, y, z] = await Promise.all([svc.issue(draft(null, 7, { action: "refusal" })), svc.issue(draft(null, 7, { action: "refusal" })), svc.issue(draft(null, 7, { action: "refusal" }))]);
      expect(new Set([x.receiptId, y.receiptId, z.receiptId]).size).toBe(1);
      const rows = await db.select().from(schema.receipts).where(eq(schema.receipts.idemKey, `${draft(null, 7).requestHash.toLowerCase()}:b_7`));
      expect(rows.length).toBe(1);
      expect(published.length).toBe(3); // owner-null receipts publish nothing; duplicates publish nothing
    },
    T,
  );

  (ANVIL_URL ? test : test.skip)(
    "proof-verifies-on-chain",
    async () => {
      const rpc = anvilClient();
      const poster = await posterFor(rpc, "service-test");
      const { address } = await deployAnchor(rpc, poster.address, "service-test");
      const at = new Date(Date.now() - 3 * 3_600_000);
      let tick = 0;
      const svc: ReceiptService = createReceiptService({ db, signer: devSigner(31337, "rs2"), now: () => new Date(at.getTime() + tick++ * 1000) });
      const issued = [];
      for (let i = 0; i < 7; i++) issued.push(await svc.issue(draft(`0x${String(i % 3).padStart(40, "e")}` as Hex, 100 + i)));
      const hour = hourOf(at);
      const p0 = await svc.proof(issued[3]!.receiptId);
      expect(p0.hourEpoch).toBe(hour);
      expect(p0.root).toBeNull(); // not anchored yet
      const { buildTree } = await import("../src");
      const leaves = (await import("../src")).pgReceiptStore(db);
      const tree = buildTree((await leaves.byHour(hour)).map((l) => l.leaf));
      await postRootDirect(rpc, poster, address, hour, tree.root, 7);
      await db.insert(schema.receiptRoots).values({ hourEpoch: hour, root: tree.root, leafCount: 7, txHash: null, status: "posted" });
      const verify = [{ type: "function", name: "verifyReceipt", stateMutability: "view", inputs: [{ type: "uint64" }, { type: "bytes32" }, { type: "bytes32[]" }], outputs: [{ type: "bool" }] }] as const;
      for (const r of issued) {
        const p = await svc.proof(r.receiptId);
        expect(p.root).toBe(tree.root);
        const ok = await rpc.readContract({ address, abi: verify, functionName: "verifyReceipt", args: [BigInt(hour), receiptHash(r), p.proof] });
        expect(ok).toBe(true);
      }
      // a proof for another receipt's hash does not verify
      const p1 = await svc.proof(issued[1]!.receiptId);
      expect(await rpc.readContract({ address, abi: verify, functionName: "verifyReceipt", args: [BigInt(hour), receiptHash(issued[2]!), p1.proof] })).toBe(false);
    },
    T,
  );
});
