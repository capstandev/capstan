// Security review r1, review-r1:6 F3: the public /proof and /verify routes must not reload and rehash the whole hour
// on every call. The hour's tree is built once and cached (anchored hours for good, the open hour for a few seconds),
// the hour query never reads receipt bodies, and an anchored root read from the chain is cached too.
// Needs DATABASE_URL (skips without it).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createTempDatabase, schema, type Db } from "@capstan/core";
import { buildTree, createReceiptService, drafts, nobleSigner } from "@capstan/receipts";
import type { Hex, Receipt } from "@capstan/schema";
import { drizzle } from "drizzle-orm/postgres-js";
// the same client the core package uses, with a query log (test only)
import postgres from "../../../packages/core/node_modules/postgres";
import { createReceiptRoutes, dbReceiptDeps, lruCache } from "../src/routes/receipts.routes";
import { addr, gwKey, smallApp, T } from "./gw-helpers";

const PG = process.env.DATABASE_URL;
const d = PG ? describe : describe.skip;

d("security r1 F3", () => {
  let tmp: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  const queries: string[] = [];
  const made: Receipt[] = [];
  const signer = nobleSigner(gwKey("f3-receipt-signer"));
  beforeAll(async () => {
    tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_sec_f3" });
    db = drizzle(postgres(tmp.url, { max: 4, onnotice: () => {}, debug: (_c, q) => void queries.push(q) }), { schema }) as unknown as Db;
    const svc = createReceiptService({ db, signer, now: () => new Date(T) });
    for (let i = 0; i < 120; i++) made.push(await svc.issue(drafts.refusal({ requestHash: `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex, eligibilityDecisionId: "elig-f3", owner: addr(gwKey(`f3-owner-${i % 7}`)) })));
  }, 120_000);
  afterAll(async () => {
    if (db) await closeDb(db);
    await tmp?.drop();
  }, 60_000);

  const hourScans = () => queries.filter((q) => /from "receipts"/i.test(q) && /"hour_epoch" = /i.test(q) && !/limit/i.test(q));

  test("open-hour-tree-is-cached-and-bodies-never-read", async () => {
    const deps = { ...dbReceiptDeps(db, { signers: [signer.address], readRoot: async () => null }), now: () => T + 1000 };
    const routes = createReceiptRoutes(() => deps);
    const { app } = await smallApp(routes, {});
    queries.length = 0;
    for (let i = 0; i < 20; i++) {
      expect((await app.request(`/v1/receipts/${made[i]!.receiptId}/proof`)).status).toBe(200);
      expect((await app.request(`/v1/receipts/${made[i]!.receiptId}/verify`)).status).toBe(200);
    }
    // 40 public calls on the same hour: at most one scan of the hour, and never its bodies
    expect(hourScans().length).toBeLessThanOrEqual(1);
    expect(hourScans().every((q) => !/"body"/i.test(q))).toBe(true);
  });

  test("anchored-hour-and-chain-root-are-cached", async () => {
    const leaves = await (await import("@capstan/receipts")).pgReceiptStore(db).byHour(Math.floor(T / 3_600_000));
    const root = buildTree(leaves.map((l) => l.leaf)).root;
    await db.insert(schema.receiptRoots).values({ hourEpoch: Math.floor(T / 3_600_000), root, leafCount: leaves.length, status: "posted" } as never);
    let rpc = 0;
    const deps = { ...dbReceiptDeps(db, { signers: [signer.address], readRoot: async () => (rpc++, root) }), now: () => T + 1000 };
    const routes = createReceiptRoutes(() => deps);
    const { app } = await smallApp(routes, {});
    queries.length = 0;
    for (let i = 0; i < 20; i++) {
      const v = (await (await app.request(`/v1/receipts/${made[i]!.receiptId}/verify`)).json()) as { valid: boolean };
      expect(v.valid).toBe(true);
    }
    expect(hourScans().length).toBeLessThanOrEqual(1);
    expect(rpc).toBeLessThanOrEqual(1);
  });

  test("a-receipt-newer-than-the-cached-tree-still-verifies", async () => {
    // a fresh hour, cached with one receipt, then a second receipt lands in it
    const h = T + 3_600_000;
    const svc = createReceiptService({ db, signer, now: () => new Date(h) });
    const deps = { ...dbReceiptDeps(db, { signers: [signer.address], readRoot: async () => null }), now: () => h + 1000 };
    const { app } = await smallApp(createReceiptRoutes(() => deps), {});
    const proofOk = async (id: string) => ((await (await app.request(`/v1/receipts/${id}/verify`)).json()) as { checks: { proof: boolean } }).checks.proof;
    const a = await svc.issue(drafts.refusal({ requestHash: `0x${"a1".repeat(32)}` as Hex, eligibilityDecisionId: "elig-f3n", owner: null }));
    expect(await proofOk(a.receiptId)).toBe(true);
    const b = await svc.issue(drafts.refusal({ requestHash: `0x${"b2".repeat(32)}` as Hex, eligibilityDecisionId: "elig-f3n", owner: null }));
    expect(await proofOk(b.receiptId)).toBe(true);
  });

  test("a-receipt-stored-after-its-hour-was-anchored-gets-no-proof-not-an-error", async () => {
    // hour T is pinned as posted (the test above); a receipt with a ts in that hour lands afterwards
    const deps = { ...dbReceiptDeps(db, { signers: [signer.address], readRoot: async () => null }), now: () => T + 1000 };
    const { app } = await smallApp(createReceiptRoutes(() => deps), {});
    expect((await app.request(`/v1/receipts/${made[0]!.receiptId}/proof`)).status).toBe(200); // pins the hour
    const svc = createReceiptService({ db, signer, now: () => new Date(T + 5_000) });
    const late = await svc.issue(drafts.refusal({ requestHash: `0x${"c3".repeat(32)}` as Hex, eligibilityDecisionId: "elig-f3late", owner: null }));
    const p = await app.request(`/v1/receipts/${late.receiptId}/proof`);
    expect(p.status).toBe(200);
    expect(((await p.json()) as { proof: unknown[] }).proof).toEqual([]);
    const v = await app.request(`/v1/receipts/${late.receiptId}/verify`);
    expect(v.status).toBe(200);
    expect(((await v.json()) as { valid: boolean; checks: { proof: boolean } }).checks.proof).toBe(false);
    // the anchored receipts of that hour still verify
    expect(((await (await app.request(`/v1/receipts/${made[1]!.receiptId}/proof`)).json()) as { proof: unknown[] }).proof.length).toBeGreaterThan(0);
  });

  test("the-cache-is-bounded-by-leaves-and-fresh-rebuilds-share-one-load", async () => {
    // hour T holds 121 receipts (120 plus the late one), hour T + 1 h holds 2
    const hB = T + 3_600_000; // the 2 receipts of the newer-receipt test
    // room for one big hour only: hour B evicts hour A, so A is scanned again
    const deps = { ...dbReceiptDeps(db, { signers: [signer.address], readRoot: async () => null, limits: { maxCachedLeaves: 122 } }), now: () => T + 2 * 3_600_000 };
    const { app } = await smallApp(createReceiptRoutes(() => deps), {});
    const idB = (await (await import("@capstan/receipts")).pgReceiptStore(db).byHour(Math.floor(hB / 3_600_000)))[0]!.id;
    queries.length = 0;
    await app.request(`/v1/receipts/${made[0]!.receiptId}/proof`);
    await app.request(`/v1/receipts/${made[1]!.receiptId}/proof`);
    expect(hourScans().length).toBe(1);
    await app.request(`/v1/receipts/${idB}/proof`);
    await app.request(`/v1/receipts/${made[2]!.receiptId}/proof`);
    expect(hourScans().length).toBe(3); // A, B, then A again (it no longer fit)

    // two receipts newer than the cached open-hour tree, asked at once: one rebuild serves both
    const hC = T + 5 * 3_600_000;
    const svc = createReceiptService({ db, signer, now: () => new Date(hC) });
    const depsC = { ...dbReceiptDeps(db, { signers: [signer.address], readRoot: async () => null }), now: () => hC + 1000 };
    const appC = (await smallApp(createReceiptRoutes(() => depsC), {})).app;
    const first = await svc.issue(drafts.refusal({ requestHash: `0x${"d4".repeat(32)}` as Hex, eligibilityDecisionId: "elig-f3c", owner: null }));
    await appC.request(`/v1/receipts/${first.receiptId}/proof`);
    const x = await svc.issue(drafts.refusal({ requestHash: `0x${"e5".repeat(32)}` as Hex, eligibilityDecisionId: "elig-f3c", owner: null }));
    const y = await svc.issue(drafts.refusal({ requestHash: `0x${"f6".repeat(32)}` as Hex, eligibilityDecisionId: "elig-f3c", owner: null }));
    queries.length = 0;
    const [px, py] = await Promise.all([appC.request(`/v1/receipts/${x.receiptId}/proof`), appC.request(`/v1/receipts/${y.receiptId}/proof`)]);
    expect(hourScans().length).toBe(1);
    expect(((await px.json()) as { proof: unknown[] }).proof.length).toBeGreaterThan(0);
    expect(((await py.json()) as { proof: unknown[] }).proof.length).toBeGreaterThan(0);
  });
});

describe("security r1 F3 cache", () => {
  test("fresh-calls-share-a-load-in-flight-and-weight-evicts", async () => {
    const c = lruCache<number, string>(16, { weigh: (v) => v.length, maxWeight: 5 });
    let loads = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const load = async () => (loads++, await gate, { value: "abc", ttlMs: 60_000 });
    await Promise.all([c(1, 0, async () => ({ value: "x", ttlMs: 60_000 })), Promise.resolve()]);
    // two callers that both need a rebuild of key 1, at once: one load
    const a = c(1, 0, load, true);
    const b = c(1, 0, load, true);
    open();
    expect(await a).toBe("abc");
    expect(await b).toBe("abc");
    expect(loads).toBe(1);
    // weight: "abc" (3) + "def" (3) is over 5, so key 1 goes
    await c(2, 0, async () => ({ value: "def", ttlMs: 60_000 }));
    let again = 0;
    await c(1, 0, async () => (again++, { value: "abc", ttlMs: 60_000 }));
    expect(again).toBe(1);
  });
});

