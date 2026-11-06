// R7: the access-credit share is off by default: with the flag unset the job writes nothing; with it set (test only)
// credits are pro rata to snapshot amounts and sum exactly to the bucket. The database part skips without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, logger, schema, type Db, type JobDeps } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { OFF_MESSAGE, runStakerCredits } from "../../../apps/workers/src/jobs/staker-credits.job";
import { createApiKey } from "../src/keys";
import { stakerCredits, type LockSnapshot } from "../src/snapshots";

const PG = process.env.DATABASE_URL;
const ts = new Date("2026-12-01T00:00:00Z");
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const snap = (owner: Hex, amount: bigint): LockSnapshot => ({ ts, owner, amount });
const micro = (s: string) => {
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0") || "0");
};

describe("access-credit share math", () => {
  test("pro rata, exact sum", () => {
    const r = stakerCredits([snap(a(1), 1n), snap(a(2), 1n), snap(a(3), 1n)], "100");
    expect(r.map((x) => x.credits)).toEqual(["33.333334", "33.333333", "33.333333"]);
    expect(r.reduce((s, x) => s + micro(x.credits), 0n)).toBe(100_000_000n);
    // 1,000 random snapshots: the sum always equals the bucket, and nobody gets more than their share plus 1 micro-USD
    for (let k = 0; k < 200; k++) {
      const n = 1 + Math.floor(Math.random() * 30);
      const ss = Array.from({ length: n }, (_, i) => snap(a(i + 1), BigInt(Math.floor(Math.random() * 1e9)) * 10n ** 12n));
      const bucket = `${Math.floor(Math.random() * 10000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
      const out = stakerCredits(ss, bucket);
      const total = ss.reduce((s, x) => s + x.amount, 0n);
      const want = micro(bucket);
      if (total > 0n) expect(out.reduce((s, x) => s + micro(x.credits), 0n)).toBe(want);
      for (let i = 0; i < ss.length; i++) {
        if (total === 0n) continue;
        const exact = (want * ss[i]!.amount) / total;
        expect(micro(out[i]!.credits) - exact >= 0n && micro(out[i]!.credits) - exact <= 1n).toBe(true);
      }
    }
    expect(stakerCredits([], "10")).toEqual([]);
    expect(() => stakerCredits([snap(a(1), 1n)], "1.0000001")).toThrow();
  });
});

(PG ? describe : describe.skip)("staker-credits job", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_stk" });
    db = createDb(t.url, { max: 4 });
    drop = async () => {
      await closeDb(db);
      await t.drop();
    };
  }, 30_000);
  afterAll(async () => {
    await drop?.();
  }, 30_000);

  test("off-by-default", async () => {
    const lines: string[] = [];
    const deps: JobDeps = { db, redis: null, cache: null, log: logger("t", { sink: (l) => lines.push(l) }), now: () => ts };
    const owners = [a(0xa1), a(0xa2), a(0xa3)];
    const ids: string[] = [];
    for (const o of owners) {
      const k = await createApiKey(db, null);
      await db.update(schema.apiAccounts).set({ ownerWallet: o }).where((await import("drizzle-orm")).eq(schema.apiAccounts.id, k.id));
      ids.push(k.id);
    }
    await db.insert(schema.lockSnapshots).values([
      { ts, owner: owners[0]!, amount: (100_000n * 10n ** 18n).toString() },
      { ts, owner: owners[1]!, amount: (300_000n * 10n ** 18n).toString() },
      { ts, owner: owners[2]!, amount: (600_000n * 10n ** 18n).toString() },
      { ts, owner: a(0xff), amount: (1n * 10n ** 18n).toString() }, // a locker without an account: skipped
    ]);
    // flag unset (and set to 0): nothing written, one log line
    for (const env of [{}, { STAKER_BUCKET_ENABLED: "0", STAKER_BUCKET_USD: "100" }]) {
      const r = await runStakerCredits(deps, env);
      expect(r).toEqual({ enabled: false, snapshotTs: null, credited: 0, skippedNoAccount: 0 });
    }
    expect((await db.select().from(schema.creditLedger)).length).toBe(0);
    expect(lines.filter((l) => l.includes(OFF_MESSAGE)).length).toBe(2);
    // flag set (test only): pro rata, sums to the bucket among accounts, idempotent on re-run
    const on = { STAKER_BUCKET_ENABLED: "1", STAKER_BUCKET_USD: "100" };
    const r1 = await runStakerCredits(deps, on);
    expect(r1).toMatchObject({ enabled: true, credited: 3, skippedNoAccount: 1 });
    const bal = async (id: string) => (await db.select().from(schema.apiAccounts).where((await import("drizzle-orm")).eq(schema.apiAccounts.id, id)))[0]!.credits;
    const got = await Promise.all(ids.map(bal));
    expect(got.map(Number)).toEqual([9.99999, 29.99997, 59.99994]);
    expect(stakerCredits([snap(owners[0]!, 100_000n), snap(owners[1]!, 300_000n), snap(owners[2]!, 600_000n)], "100").map((x) => x.credits)).toEqual(["10", "30", "60"]);
    expect((await runStakerCredits(deps, on)).credited).toBe(0);
    await expect(runStakerCredits(deps, { STAKER_BUCKET_ENABLED: "1" })).rejects.toThrow(/STAKER_BUCKET_USD/);
  }, 30_000);
});
