import type { Db } from "@capstan/core";
import { db as schema } from "@capstan/schema";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { insertRequestLog } from "@capstan/telemetry";
import { computeDay } from "../usage";
import { addr, dbDescribe, freshDb, HOOK_TIMEOUT_MS } from "./helpers";

dbDescribe("sources", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await freshDb()), HOOK_TIMEOUT_MS);
  afterAll(async () => await drop());
  const T = (h: number) => new Date(Date.UTC(2026, 10, 5, h));

  test("mcp-and-x402: MCP calls and unique clients from the request log (hashed ids), x402 from settled payments only", async () => {
    for (const [client, h] of [["sess-a", 1], ["sess-a", 2], ["sess-b", 3], ["sess-c", 23]] as const) await insertRequestLog(db, { service: "mcp", route: "tools/call", clientId: client, status: 200, ts: T(h) }, "salt");
    await insertRequestLog(db, { service: "api", route: "/v1/markets", clientId: "key", status: 200, ts: T(4) }, "salt"); // not mcp
    await insertRequestLog(db, { service: "mcp", route: "tools/call", clientId: "sess-z", status: 200, ts: new Date(Date.UTC(2026, 10, 6, 0, 0, 1)) }, "salt"); // next day
    const pay = (id: string, chain: string, asset: string, amount: string, status: string, endpoint = "/v1/spreads/scan") =>
      db.insert(schema.x402Payments).values({ id, chain, asset, method: "eip3009", payer: addr(7), amount, endpoint, txHash: null, status, ts: T(5) });
    await pay("p1", "eip155:8453", "0xUSDC", "10000", "settled");
    await pay("p2", "eip155:8453", "0xUSDC", "20000", "settled");
    await pay("p3", "solana:mainnet", "EPjUSDC", "10000", "settled");
    await pay("p4", "eip155:8453", "0xUSDC", "990000", "failed");
    await pay("p5", "eip155:8453", "0xUSDC", "990000", "settling");
    const u = await computeDay("2026-11-05", { db });
    expect(u.mcp).toEqual({ calls: 4, uniqueClients: 3 });
    expect(u.x402.payments).toBe(3);
    expect(u.x402.usd).toBe("0.040000");
    expect(u.x402.byRail).toEqual({ "eip155:8453:0xusdc": "0.030000", "solana:mainnet:epjusdc": "0.010000" });
    // raw client ids never stored
    const rows = await db.select().from(schema.requestLogs);
    expect(JSON.stringify(rows)).not.toContain("sess-a");
  });

  test("notional and fees: accruals for HL and Aster, Capstan fills for Lighter; refusals by code", async () => {
    await db.insert(schema.builderFeeAccruals).values([
      { day: "2026-11-05", venue: "hyperliquid", builder: addr(0xb0), fills: 3, notionalUsd: "120000.5", feeUsd: "24.0001", unmatchedFills: 0, source: "hl_user_fills" },
      { day: "2026-11-05", venue: "aster", builder: addr(0xb1), fills: 1, notionalUsd: "5000", feeUsd: "1", unmatchedFills: 0, source: "aster_ledger" },
      { day: "2026-11-04", venue: "hyperliquid", builder: addr(0xb0), fills: 9, notionalUsd: "999", feeUsd: "9", unmatchedFills: 0, source: "hl_user_fills" },
    ]);
    await db.insert(schema.orderBuilds).values({ id: "b1", owner: addr(1), venue: "lighter-mainnet", marketId: "lighter-mainnet:-:ETH", intent: {}, payload: {}, preview: {}, eligibilityDecisionId: "e3", expiresAt: T(1) });
    {
      await db.insert(schema.orders).values({ id: "o1", buildId: "b1", venue: "lighter-mainnet", marketId: "lighter-mainnet:-:ETH", owner: addr(1), signedPayloadHash: "sh1", mode: "direct", status: "filled", builderFeeBps: 0, submittedAt: T(1) });
      await db.insert(schema.fills).values([
        { id: "f1", orderId: "o1", venue: "lighter-mainnet", venueOrderId: "1", px: "2000", sz: "-1.5", feeUsd: "0", builderFeeUsd: "0", ts: T(2) },
        { id: "f2", orderId: null, venue: "lighter-mainnet", venueOrderId: "2", px: "2000", sz: "10", feeUsd: "0", builderFeeUsd: "0", ts: T(2) }, // not ours
      ]);
    }
    await db.insert(schema.eligibilityDecisions).values([
      { id: "e1", rulesVersion: 1, allowed: false, code: "REGION_REFUSED", ipCountry: "US", ts: T(3) },
      { id: "e2", rulesVersion: 1, allowed: false, code: "REGION_REFUSED", ipCountry: "CA", ts: T(4) },
      { id: "e3", rulesVersion: 1, allowed: true, code: null, ipCountry: "DE", ts: T(4) },
    ]);
    const u = await computeDay("2026-11-05", { db });
    expect(u.routedNotionalUsd.hl).toBe("120000.500000");
    expect(u.routedNotionalUsd.aster).toBe("5000.000000");
    expect(u.routedNotionalUsd.lighter304).toBe("3000.000000"); // |2000 x -1.5|; the fill without a Capstan order is not routed
    expect(u.routedNotionalUsd.lighterRh).toBe("0.000000");
    expect(u.builderFeeUsd).toEqual({ hl: "24.000100", aster: "1.000000" });
    expect(u.refusals).toEqual({ REGION_REFUSED: 2 });
    expect(u.visitors).toBeNull();
  });
});
