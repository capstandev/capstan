// R12 (todo 29): a receipt is served by id to anyone; listing an owner's receipts needs that owner's signature.
// Also /proof and /verify on a real receipt. Needs DATABASE_URL (skips without it).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, type Db } from "@capstan/core";
import { createReceiptService, drafts, nobleSigner } from "@capstan/receipts";
import type { Hex, Receipt } from "@capstan/schema";
import { ownerSigVerifier } from "../src/auth";
import { createReceiptRoutes, dbReceiptDeps } from "../src/routes/receipts.routes";
import { addr, gwKey, HOST, memoryNonceStore, signed, smallApp, T } from "./gw-helpers";

const PG = process.env.DATABASE_URL;
const d = PG ? describe : describe.skip;
const alice = gwKey("receipts-alice");
const bob = gwKey("receipts-bob");

d("receipt routes", () => {
  let tmp: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  const made: Receipt[] = [];
  const signer = nobleSigner(gwKey("receipt-signer"));
  beforeAll(async () => {
    tmp = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_receipts_routes" });
    db = createDb(tmp.url, { max: 4 });
    const svc = createReceiptService({ db, signer, now: () => new Date(T) });
    for (const [i, owner] of [alice, alice, bob].entries()) made.push(await svc.issue(drafts.onboardingComplete({ owner: addr(owner), venue: "hyperliquid", agentRef: `hl:${i}`, requestHash: `0x${String(i + 1).padStart(64, "0")}` as Hex, eligibilityDecisionId: "elig-r" })));
  }, 60_000);
  afterAll(async () => {
    if (db) await closeDb(db);
    await tmp?.drop();
  }, 60_000);

  test("privacy", async () => {
    const routes = createReceiptRoutes(() => ({ ...dbReceiptDeps(db, { signers: [signer.address], readRoot: async () => null }), now: () => T + 1000 }));
    const { app } = await smallApp(routes, { verifiers: { owner_sig: ownerSigVerifier({ nonces: memoryNonceStore(), host: HOST, now: () => T + 1000, agentsOf: async () => [] }) } });
    // by id: public
    const one = await app.request(`/v1/receipts/${made[2]!.receiptId}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as Receipt).receiptId).toBe(made[2]!.receiptId);
    expect((await app.request("/v1/receipts/01JNOTAREALRECEIPT00000000")).status).toBe(404);
    // /verify on a real receipt: the signature checks, the root is not posted yet
    const v = (await (await app.request(`/v1/receipts/${made[0]!.receiptId}/verify`)).json()) as { valid: boolean; status: string; checks: { signature: boolean; onChainRoot: unknown } };
    expect(v.checks.signature).toBe(true);
    expect(v.checks.onChainRoot).toBe("not_posted");
    // security r1 F1: an hour whose root is not posted yet is pending, never valid
    expect(v.valid).toBe(false);
    expect(v.status).toBe("pending");
    expect((await app.request(`/v1/receipts/${made[0]!.receiptId}/proof`)).status).toBe(200);
    // listing: no signature, someone else's signature, or a signature for another owner are all refused
    const listPath = (o: Hex) => `/v1/receipts?owner=${o}`;
    expect((await app.request(listPath(addr(alice)))).status).toBe(401);
    expect((await app.request(listPath(addr(alice)), { headers: signed(bob, { method: "GET", path: listPath(addr(alice)), owner: addr(alice) }) })).status).toBe(401);
    expect((await app.request(listPath(addr(alice)), { headers: signed(bob, { method: "GET", path: listPath(addr(alice)) }) })).status).toBe(401);
    // the owner's own signature lists exactly its own receipts
    const mine = await app.request(listPath(addr(alice)), { headers: signed(alice, { method: "GET", path: listPath(addr(alice)) }) });
    expect(mine.status).toBe(200);
    const list = ((await mine.json()) as { receipts: Receipt[] }).receipts;
    expect(list.map((r) => r.receiptId).sort()).toEqual([made[0]!.receiptId, made[1]!.receiptId].sort());
    expect(list.every((r) => r.owner === addr(alice))).toBe(true);
  });

  test("security-r1-f1-old-empty-hour-is-invalid", async () => {
    // the same receipts read 4 hours later, or once a later hour is anchored: the hour can never be anchored
    for (const extra of [{ now: () => T + 4 * 3_600_000 }, { now: () => T + 1000, latestHour: async () => Math.floor(T / 3_600_000) + 1 }]) {
      const routes = createReceiptRoutes(() => ({ ...dbReceiptDeps(db, { signers: [signer.address], readRoot: async () => null }), ...extra }));
      const { app } = await smallApp(routes, { verifiers: { owner_sig: ownerSigVerifier({ nonces: memoryNonceStore(), host: HOST, now: () => T + 1000, agentsOf: async () => [] }) } });
      const v = (await (await app.request(`/v1/receipts/${made[0]!.receiptId}/verify`)).json()) as { valid: boolean; status: string; checks: { onChainRoot: unknown } };
      expect(v).toMatchObject({ valid: false, status: "invalid", checks: { onChainRoot: "unanchored" } });
    }
  });
});
