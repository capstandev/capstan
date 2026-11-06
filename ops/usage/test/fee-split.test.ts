import type { Db } from "@capstan/core";
import { db as schema } from "@capstan/schema";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { feeSplit, formatFeeSplit, splitBuckets } from "../fee-split";
import { usd } from "../usage";
import { addr, dbDescribe, freshDb, HOOK_TIMEOUT_MS } from "./helpers";

const sum = (b: ReturnType<typeof splitBuckets>) => [b.workerUsd, b.treasuryUsd, b.stakersUsd, b.burnUsd].reduce((a, x) => a + usd(x).v, 0n);

describe("fee split", () => {
  test("sums-and-staker-held: the four buckets sum to the inflow exactly; stakers held while the flag is off; no address", () => {
    const b = splitBuckets("1000.000000");
    expect(b).toEqual({ workerUsd: "800.000000", treasuryUsd: "100.000000", stakersUsd: "50.000000", burnUsd: "50.000000" });
    // rounding leftovers go to the treasury, so the sum is exact
    const odd = splitBuckets("0.000003");
    expect(sum(odd)).toBe(3n);
    expect(odd).toEqual({ workerUsd: "0.000002", treasuryUsd: "0.000001", stakersUsd: "0.000000", burnUsd: "0.000000" });
    for (let i = 0; i < 2000; i++) {
      const total = `${Math.floor(Math.random() * 1e7)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
      const s = splitBuckets(total);
      expect(sum(s)).toBe(usd(total).v);
      for (const v of Object.values(s)) expect(usd(v).v >= 0n).toBeTrue();
    }
    expect(() => splitBuckets("-1")).toThrow();
  });
});

dbDescribe("fee split (database)", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await freshDb()), HOOK_TIMEOUT_MS);
  afterAll(async () => await drop());

  test("month totals from accruals and settled x402 payments; top-ups shown, not added twice", async () => {
    await db.insert(schema.builderFeeAccruals).values([
      { day: "2026-11-02", venue: "hyperliquid", builder: addr(0xb0), fills: 10, notionalUsd: "500000", feeUsd: "100.123456", unmatchedFills: 0, source: "hl_user_fills" },
      { day: "2026-11-30", venue: "aster", builder: addr(0xb1), fills: 2, notionalUsd: "10000", feeUsd: "2", unmatchedFills: 0, source: "aster_ledger" },
      { day: "2026-12-01", venue: "hyperliquid", builder: addr(0xb0), fills: 1, notionalUsd: "1", feeUsd: "999", unmatchedFills: 0, source: "hl_user_fills" }, // next month
    ]);
    const pay = (id: string, amount: string, endpoint: string, status = "settled", ts = new Date(Date.UTC(2026, 10, 15))) =>
      db.insert(schema.x402Payments).values({ id, chain: "eip155:8453", asset: "0xUSDC", method: "eip3009", payer: addr(9), amount, endpoint, txHash: null, status, ts });
    await pay("x1", "20000000", "/v1/credits/topup/20");
    await pay("x2", "10000", "/v1/funding/forecast");
    await pay("x3", "5000000", "/v1/credits/topup/5", "failed");
    const f = await feeSplit(db, "2026-11", { stakerFlag: false });
    expect(f.inflow).toEqual({ hlBuilderUsd: "100.123456", asterBuilderUsd: "2.000000", x402Usd: "20.010000", creditTopupsUsd: "20.000000", totalUsd: "122.133456" });
    expect(sum(f.buckets)).toBe(usd("122.133456").v);
    expect(f.stakersCredited).toBeFalse();
    const text = formatFeeSplit(f);
    expect(text).toContain("Stakers 5%: held (flag off)");
    expect(text).toContain("Burn 5% (AMOUNT_USDG for the burn plan)");
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(formatFeeSplit(await feeSplit(db, "2026-11", { stakerFlag: true }))).toContain("Stakers 5%: credited");
    await expect(feeSplit(db, "2026-13", { stakerFlag: false })).rejects.toThrow();
  });
});
