// Account and credits routes end to end on a real database: create a key with an api_key_create signature, read
// the account (free, no lock required), spend nothing, top-up route answers 202 or 404. Skips without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { capstanMessage, closeDb, createDb, createTempDatabase, memoryNonceStore, type Db } from "@capstan/core";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../../apps/api/src/app";
import { createAccountRoutes, NO_LOCK } from "../../../apps/api/src/routes/account.routes";
import { createCreditsRoutes } from "../../../apps/api/src/routes/credits.routes";
import { topUpCredits } from "../src/credits";

const PG = process.env.DATABASE_URL;
const owner = privateKeyToAccount(keccak256(toHex("capstan-plans-routes:owner"))); // test-key (public label)

(PG ? describe : describe.skip)("account and credits routes", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_proutes" });
    db = createDb(t.url, { max: 4 });
    drop = async () => {
      await closeDb(db);
      await t.drop();
    };
  }, 30_000);
  afterAll(async () => {
    await drop?.();
  }, 30_000);

  test("keys, account, credits", async () => {
    const deps = { db, lock: NO_LOCK, host: "api.example.test", nonces: memoryNonceStore() };
    const allow = () => null;
    const empty = mkdtempSync(join(tmpdir(), "capstan-empty-routes-"));
    const { app } = await createApp({ routesDir: empty, extraRoutes: [...createAccountRoutes(() => deps), ...createCreditsRoutes(() => deps)], verifiers: { owner_sig: allow, api_key: allow, x402: allow } });
    rmSync(empty, { recursive: true, force: true });
    const now = Date.now();
    const message = capstanMessage({ purpose: "api_key_create", owner: owner.address, host: "api.example.test", chainId: 4663, nonce: "routes-nonce-0001", issuedAt: now, expiresAt: now + 60_000 });
    const sig = await owner.signMessage({ message });
    const post = (body: unknown) => app.request("/v1/account/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const made = await post({ owner: owner.address, message, sig });
    expect(made.status).toBe(201);
    const k = (await made.json()) as { id: string; key: string; note: string };
    expect(k.note).toContain("not a wallet key");
    expect((await post({ owner: owner.address, message, sig })).status).toBe(401); // replayed
    expect((await post({ owner: "nope" })).status).toBe(400);

    const acct = await app.request("/v1/account", { headers: { "x-api-key": k.key } });
    expect(acct.status).toBe(200);
    expect(await acct.json()).toMatchObject({ id: k.id, tier: "free", multiplier: 1, lockRequired: false, credits: "0", limits: { relayOrdersPerMinPerWallet: 2 } });
    expect((await app.request("/v1/account", { headers: { authorization: "Bearer cpst_bad" } })).status).toBe(401);

    expect((await app.request(`/v1/credits/topup/20?account=${k.id}`, { method: "POST" })).status).toBe(202);
    expect((await app.request("/v1/credits/topup/20?account=01ARZ3NDEKTSV4RRFFQ69G5FAV", { method: "POST" })).status).toBe(404);
    expect((await app.request("/v1/credits/topup/20", { method: "POST" })).status).toBe(400);
    // a repeated ?account= is refused before any payment settles (the after-settle hook would not credit it)
    expect((await app.request(`/v1/credits/topup/20?account=${k.id}&account=${k.id}`, { method: "POST" })).status).toBe(400);
    await topUpCredits(db, k.id, { id: "eip155:8453:0x01", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "20000000", decimals: 6, payer: "0x1", status: "settled" });
    const cr = await app.request("/v1/credits", { headers: { authorization: `Bearer ${k.key}` } });
    expect(await cr.json()).toMatchObject({ credits: "20", ledger: [{ delta: "20", reason: "topup" }] });
  }, 30_000);
});
