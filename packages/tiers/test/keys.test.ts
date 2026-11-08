// R5: API keys are stored as hashes only (sha256 of a 256-bit secret since security review r1 F1; legacy argon2id still verifies); the plain key is returned once; a wrong key fails; no table holds
// the plain key. R11 (SIG-1): the owner signature must be a capstanMessage with purpose api_key_create; read and
// api_request signatures are refused. Skips without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { capstanMessage, closeDb, createDb, createTempDatabase, memoryNonceStore, schema, type Db } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ApiKeyError, createApiKey, verifyApiKey } from "../src/keys";

const PG = process.env.DATABASE_URL;
const owner = privateKeyToAccount(keccak256(toHex("capstan-plans-test:owner"))); // test-key (public label)
const HOST = "api.example.test";

(PG ? describe : describe.skip)("api keys", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_keys" });
    db = createDb(t.url, { max: 4 });
    drop = async () => {
      await closeDb(db);
      await t.drop();
    };
  }, 30_000);
  afterAll(async () => {
    await drop?.();
  }, 30_000);

  test("hash-only (sha256 form)", async () => {
    const k = await createApiKey(db, null);
    expect(k.key.startsWith(`cpst_${k.id}_`)).toBe(true);
    const rows = await db.select().from(schema.apiAccounts);
    expect(rows.length).toBe(1);
    expect(rows[0]!.keyHash.startsWith("sha256$")).toBe(true);
    // the secret is everything after "cpst_<id>_" (it may itself contain "_")
    expect(rows[0]!.keyHash).not.toContain(k.key.slice(`cpst_${k.id}_`.length));
    expect(await verifyApiKey(db, k.key)).toMatchObject({ id: k.id, tier: "free", ownerWallet: null });
    // wrong secret, wrong id, malformed
    const wrong = k.key.slice(0, -1) + (k.key.endsWith("A") ? "B" : "A");
    expect(await verifyApiKey(db, wrong)).toBeNull();
    expect(await verifyApiKey(db, `cpst_01ARZ3NDEKTSV4RRFFQ69G5FAV_${k.key.slice(`cpst_${k.id}_`.length)}`)).toBeNull();
    expect(await verifyApiKey(db, "nope")).toBeNull();
    // no column anywhere holds the plain key
    const dump = await db.$client.unsafe(`select string_agg(t::text, ' ') as all from (select * from api_accounts) t`);
    expect(JSON.stringify(dump)).not.toContain(k.key);
    const all = await db.$client.unsafe(`select table_name from information_schema.tables where table_schema = 'public'`);
    for (const { table_name } of all as unknown as { table_name: string }[]) {
      const r = await db.$client.unsafe(`select count(*)::int as n from "${table_name}" t where t::text like '%' || $1 || '%'`, [k.key.slice(`cpst_${k.id}_`.length)]);
      expect((r[0] as unknown as { n: number }).n, table_name).toBe(0);
    }
  }, 30_000);

  test("purpose-bound", async () => {
    const nonces = memoryNonceStore();
    const now = Date.now();
    const msg = (purpose: "api_key_create" | "read" | "api_request", nonce: string, host = HOST) =>
      capstanMessage({ purpose, owner: owner.address, host, chainId: 4663, nonce, issuedAt: now, expiresAt: now + 60_000 });
    const sign = async (m: string) => ({ message: m, sig: (await owner.signMessage({ message: m })) as Hex });
    const deps = { host: HOST, nonces, nowMs: now };
    // other purposes are refused
    for (const p of ["read", "api_request"] as const) {
      const e = await createApiKey(db, owner.address, await sign(msg(p, `nonce-${p}-0001`)), deps).catch((x) => x);
      expect(e).toBeInstanceOf(ApiKeyError);
      expect((e as ApiKeyError).reason).toContain("purpose");
    }
    // another host, another signer, no signature at all
    expect(await createApiKey(db, owner.address, await sign(msg("api_key_create", "nonce-host-0001", "evil.example")), deps).catch((x) => x)).toBeInstanceOf(ApiKeyError);
    const other = privateKeyToAccount(keccak256(toHex("capstan-plans-test:other"))); // test-key (public label)
    const m = msg("api_key_create", "nonce-other-0001");
    expect(await createApiKey(db, owner.address, { message: m, sig: (await other.signMessage({ message: m })) as Hex }, deps).catch((x) => x)).toBeInstanceOf(ApiKeyError);
    expect(await createApiKey(db, owner.address).catch((x) => x)).toBeInstanceOf(ApiKeyError);
    // the right purpose works once; a replay of the same message is refused
    const good = await sign(msg("api_key_create", "nonce-good-0001"));
    const k = await createApiKey(db, owner.address, good, deps);
    expect((await verifyApiKey(db, k.key))?.ownerWallet).toBe(owner.address.toLowerCase());
    expect(((await createApiKey(db, owner.address, good, deps).catch((x) => x)) as ApiKeyError).reason).toContain("replay");
  }, 30_000);
});

// security review r1 F1: a random secret for a known account id costs microseconds, not an argon2 verify
describe("api key verify cost (security review r1 F1)", () => {
  test("verifyApiKey on a sha256-stored key never runs argon2 and a legacy hash runs behind a semaphore", async () => {
    const { keyMatches, hashApiKey, LEGACY_ARGON2_SLOTS, ApiKeyBusyError } = await import("../src/keys");
    const key = "cpst_01ARZ3NDEKTSV4RRFFQ69G5FAV_" + "A".repeat(43);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) expect(await keyMatches(key.slice(0, -1) + "B", hashApiKey(key))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(await keyMatches(key, hashApiKey(key))).toBe(true);
    const legacy = await Bun.password.hash(key, { algorithm: "argon2id" });
    const runs = Array.from({ length: LEGACY_ARGON2_SLOTS + 4 }, () => keyMatches(key, legacy).then((v) => (v ? "ok" : "no"), (e) => (e instanceof ApiKeyBusyError ? "busy" : "err")));
    const out = await Promise.all(runs);
    expect(out.filter((x) => x === "ok").length).toBe(LEGACY_ARGON2_SLOTS);
    expect(out.filter((x) => x === "busy").length).toBe(4);
  });
});
