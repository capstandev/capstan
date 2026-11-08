// R6: a top-up from a settled x402 record adds once (idempotent on the settlement id); spendCredit never lets the
// balance go negative under 100 concurrent spends. Skips without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createDb, createTempDatabase, schema, type Db } from "@capstan/core";
import { eq } from "drizzle-orm";
import { atomicToUsd, creditsOf, CreditsError, grantCredit, spendCredit, topUpCredits, topupSettleHook, type X402SettlementRecord } from "../src/credits";
import { createApiKey } from "../src/keys";

const PG = process.env.DATABASE_URL;
const rec = (id: string, amount: string): X402SettlementRecord => ({ id, network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount, decimals: 6, payer: "0x00000000000000000000000000000000000000bb", status: "settled" });

describe("credit math", () => {
  test("atomic to usd is exact", () => {
    expect(atomicToUsd("5000000", 6)).toBe("5");
    expect(atomicToUsd("20000001", 6)).toBe("20.000001");
    expect(atomicToUsd("10000", 6)).toBe("0.01");
    expect(atomicToUsd("1", 18)).toBe("0.000000000000000001");
    expect(() => atomicToUsd("-1", 6)).toThrow(CreditsError);
  });
});

(PG ? describe : describe.skip)("credits", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_cred" });
    db = createDb(t.url, { max: 20 });
    drop = async () => {
      await closeDb(db);
      await t.drop();
    };
  }, 30_000);
  afterAll(async () => {
    await drop?.();
  }, 30_000);

  const balance = async (id: string) => (await db.select().from(schema.apiAccounts).where(eq(schema.apiAccounts.id, id)))[0]!.credits;

  test("idempotent-and-non-negative", async () => {
    const { id } = await createApiKey(db, null);
    // top-up once, even when the same settlement arrives five times at once
    const r = await Promise.all(Array.from({ length: 5 }, () => topUpCredits(db, id, rec("eip155:84532:0xaaa", "5000000"))));
    expect(r.filter(Boolean).length).toBe(1);
    expect(Number(await balance(id))).toBe(5);
    expect(await topUpCredits(db, id, rec("eip155:84532:0xaaa", "5000000"))).toBe(false);
    // a second account cannot reuse the settlement
    const { id: other } = await createApiKey(db, null);
    expect(await topUpCredits(db, other, rec("eip155:84532:0xaaa", "5000000"))).toBe(false);
    expect(Number(await balance(other))).toBe(0);
    // refused: unsettled, zero, unknown account
    await expect(topUpCredits(db, id, { ...rec("x", "1"), status: "pending" as never })).rejects.toThrow(CreditsError);
    await expect(topUpCredits(db, id, rec("y", "0"))).rejects.toThrow(/amount 0/);
    await expect(topUpCredits(db, "01ARZ3NDEKTSV4RRFFQ69G5FAV", rec("z", "1000000"))).rejects.toThrow(/unknown account/);

    // 100 concurrent spends of $0.07 against $5: exactly 71 succeed, the balance ends at $0.03, never below zero
    const spends = await Promise.all(Array.from({ length: 100 }, (_, i) => spendCredit(db, id, `/v1/spreads/scan#${i}`, "0.07")));
    expect(spends.filter(Boolean).length).toBe(71);
    expect(await balance(id)).toBe("0.03");
    expect(await spendCredit(db, id, "/v1/x", "0.04")).toBe(false);
    expect(await spendCredit(db, id, "/v1/x", "0.03")).toBe(true);
    expect(Number(await balance(id))).toBe(0);
    // the ledger matches the balance exactly
    const sum = await db.$client`select coalesce(sum(delta), 0)::text as s from credit_ledger where account_id = ${id}`;
    expect(Number((sum[0] as { s: string }).s)).toBe(0);
    expect((await creditsOf(db, id))!.ledger.length).toBe(50);
    await expect(spendCredit(db, id, "/v1/x", "0")).rejects.toThrow(CreditsError);

    // grants are once per ref (the monthly allowance)
    expect(await grantCredit(db, id, "10", "whale_allowance", "whale:2026-11")).toBe(true);
    expect(await grantCredit(db, id, "10", "whale_allowance", "whale:2026-11")).toBe(false);
    expect(Number(await balance(id))).toBe(10);

    // the after-settle hook credits the account of the request really served (transport context), once
    const served = (path: string, query: Record<string, string | string[]>, method = "POST") => ({
      request: { path, method, adapter: { getMethod: () => method, getQueryParam: (n: string) => query[n] } },
    });
    const hook = topupSettleHook(db);
    const ctx = {
      paymentPayload: { resource: { url: "https://api.example.test/v1/funding/forecast" } },
      requirements: { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "20000000" },
      result: { success: true, transaction: "0xbbb", payer: "0x1" },
      transportContext: served("/v1/credits/topup/20", { account: other }),
    };
    await hook(ctx);
    await hook(ctx);
    expect(Number(await balance(other))).toBe(20);
    await hook({ ...ctx, result: { ...ctx.result, success: false, transaction: "0xccc" } });
    // a paid call to another route is never credited, whatever resource.url the client wrote
    const forged = { url: `https://api.example.test/v1/credits/topup/20?account=${other}` };
    await hook({ ...ctx, paymentPayload: { resource: forged }, transportContext: served("/v1/funding/forecast", { account: other }, "GET"), result: { ...ctx.result, transaction: "0xddd" } });
    await hook({ ...ctx, paymentPayload: { resource: forged }, transportContext: served("/v1/funding/forecast", { account: other }), result: { ...ctx.result, transaction: "0xdd1" } });
    await hook({ ...ctx, paymentPayload: { resource: forged }, transportContext: undefined, result: { ...ctx.result, transaction: "0xdd2" } });
    // the top-up path with the wrong method, a repeated or missing account, or an amount that is not the pack price
    await hook({ ...ctx, transportContext: served("/v1/credits/topup/20", { account: other }, "GET"), result: { ...ctx.result, transaction: "0xeee" } });
    await hook({ ...ctx, transportContext: served("/v1/credits/topup/20", { account: [other, id] }), result: { ...ctx.result, transaction: "0xeef" } });
    await hook({ ...ctx, transportContext: served("/v1/credits/topup/20", {}), result: { ...ctx.result, transaction: "0xef0" } });
    await hook({ ...ctx, requirements: { ...ctx.requirements, amount: "10000" }, result: { ...ctx.result, transaction: "0xef1" } });
    await hook({ ...ctx, transportContext: served("/v1/credits/topup/20/", { account: other }), result: { ...ctx.result, transaction: "0xef2" } });
    expect(Number(await balance(other))).toBe(20);
    // the pack price check uses the token decimals when given (an 18-decimal token)
    const hook18 = topupSettleHook(db, { decimalsOf: () => 18 });
    await hook18({ ...ctx, requirements: { ...ctx.requirements, amount: "5000000000000000000" }, transportContext: served("/v1/credits/topup/5", { account: other }), result: { ...ctx.result, transaction: "0xf18" } });
    expect(Number(await balance(other))).toBe(25);
  }, 60_000);
});

// r1:3 F8: a refused request gets its credit back, with a ledger row
(PG ? describe : describe.skip)("credit refunds", () => {
  test("refundCredit adds the spend back once and writes a refund row", async () => {
    const { refundCredit } = await import("../src/credits");
    const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_crefund" });
    const db = createDb(t.url, { max: 4 });
    try {
      const { id } = await createApiKey(db, null);
      await topUpCredits(db, id, rec("eip155:84532:0xref", "1000000"));
      expect(await spendCredit(db, id, "GET /funding/forecast", "0.25")).toBe(true);
      await refundCredit(db, id, "GET /funding/forecast", "0.25");
      const row = (await db.select().from(schema.apiAccounts).where(eq(schema.apiAccounts.id, id)))[0]!;
      expect(Number(row.credits)).toBe(1);
      const ledger = await creditsOf(db, id, 10);
      expect(ledger!.ledger.some((l) => l.reason === "refund" && Number(l.delta) === 0.25)).toBe(true);
    } finally {
      await closeDb(db);
      await t.drop();
    }
  }, 30_000);
});
