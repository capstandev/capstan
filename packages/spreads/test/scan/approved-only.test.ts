// R1: only approved equivalences appear; proposed and rejected never do, even when their funding gap is the largest.
import { describe, expect, test } from "bun:test";
import { scan } from "../../src";
import { funding, M, market, REQ, setup } from "./helpers";

describe("approved only", () => {
  test("never-unapproved", async () => {
    const btcA = market("hyperliquid:-:BTC", "hyperliquid", { canonicalAsset: "CR:BTC", lotSize: "0.00001" });
    const btcB = market("lighter-mainnet:-:BTC", "lighter-mainnet", { canonicalAsset: "CR:BTC", tickSize: "0.1", lotSize: "0.00001" });
    const solA = market("hyperliquid:-:SOL", "hyperliquid", { canonicalAsset: "CR:SOL", lotSize: "0.01" });
    const solB = market("lighter-mainnet:-:SOL", "lighter-mainnet", { canonicalAsset: "CR:SOL", tickSize: "0.001", lotSize: "0.01" });
    const s = setup({
      markets: [M.hl, M.lt, btcA, btcB, solA, solB],
      eqs: [
        { id: "eq-eth", canonicalAsset: "CR:ETH", marketIds: [M.hl.id, M.lt.id], status: "approved", notes: "ok" },
        { id: "eq-btc", canonicalAsset: "CR:BTC", marketIds: [btcA.id, btcB.id], status: "proposed", notes: null },
        { id: "eq-sol", canonicalAsset: "CR:SOL", marketIds: [solA.id, solB.id], status: "rejected", notes: "different contracts" },
      ],
      fund: [
        [M.hl.id, funding(M.hl.id, "0.0001", 3600)],
        [M.lt.id, funding(M.lt.id, "0.00002", 3600)],
        // the unapproved pairs have gaps 100x larger
        [btcA.id, funding(btcA.id, "0.01", 3600)],
        [btcB.id, funding(btcB.id, "-0.01", 3600)],
        [solA.id, funding(solA.id, "0.02", 3600)],
        [solB.id, funding(solB.id, "-0.02", 3600)],
      ],
    });
    const rows = await scan(REQ, s.deps);
    expect(rows.map((r) => r.equivalenceId)).toEqual(["eq-eth"]);
    expect(await scan({ ...REQ, asset: "CR:BTC" }, s.deps)).toEqual([]);
    expect(await scan({ ...REQ, asset: "CR:SOL" }, s.deps)).toEqual([]);
    // an equity pair stays out while EQ_EXECUTION_ALLOWED is off, even approved
    const tA = market("hyperliquid:xyz:TSLA", "hyperliquid", { dex: "xyz", canonicalAsset: "EQ:TSLA", lotSize: "0.001" });
    const tB = market("aster:-:TSLAUSDT", "aster", { canonicalAsset: "EQ:TSLA", lotSize: "0.001", tickSize: "0.01" });
    const eq = setup({ markets: [tA, tB], eqs: [{ id: "eq-tsla", canonicalAsset: "EQ:TSLA", marketIds: [tA.id, tB.id], status: "approved", notes: "ok" }], fund: [[tA.id, funding(tA.id, "0.0001", 3600)], [tB.id, funding(tB.id, "0.00001", 3600)]] });
    expect(await scan(REQ, eq.deps)).toEqual([]);
  });
});
