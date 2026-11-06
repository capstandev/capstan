// R5: distancePct matches a hand-computed fixture; a null liq price gives a null distance; liqPxSource is carried.
import { describe, expect, test } from "bun:test";
import { distancePct, liquidationLadder } from "../src";
import { pos, snap } from "./helpers";

describe("ladder", () => {
  test("distances", () => {
    // long: mark 2000, liq 1700 -> 300 / 2000 = 15%; short: mark 2000, liq 2150 -> 7.5%;
    // lighter: mark from the marks map (1990.10) with liq 1791.20 -> 198.90 / 1990.10 = 9.99447% -> 9.9945 (4 dp)
    const snaps = [
      snap("hyperliquid", [pos("hyperliquid", "hyperliquid:-:ETH", { liqPx: "1700" }), pos("hyperliquid", "hyperliquid:-:BTC", { side: "short", liqPx: "2150", liqPxSource: "computed" })]),
      snap("lighter-mainnet", [pos("lighter-mainnet", "lighter-mainnet:-:ETH", { liqPx: "1791.20" }), pos("lighter-mainnet", "lighter-mainnet:-:SOL", { liqPx: null })]),
    ];
    const rows = liquidationLadder(snaps, new Map([["lighter-mainnet:-:ETH", "1990.10"]]));
    const by = new Map(rows.map((r) => [r.marketId, r]));
    expect(by.get("hyperliquid:-:ETH")!.distancePct).toBe(15);
    expect(by.get("hyperliquid:-:BTC")!.distancePct).toBe(7.5);
    expect(by.get("hyperliquid:-:BTC")!.liqPxSource).toBe("computed");
    expect(by.get("lighter-mainnet:-:ETH")!.distancePct).toBe(9.9945);
    expect(by.get("lighter-mainnet:-:ETH")!.markPx).toBe("1990.10");
    expect(by.get("lighter-mainnet:-:SOL")).toMatchObject({ liqPx: null, distancePct: null, liqPxSource: "venue" });
    // closest first, unknown last
    expect(rows.map((r) => r.marketId)).toEqual(["hyperliquid:-:BTC", "lighter-mainnet:-:ETH", "hyperliquid:-:ETH", "lighter-mainnet:-:SOL"]);
    // each row is one venue's own price: two venues' rows for one asset stay two rows
    expect(rows.filter((r) => r.marketId.endsWith(":ETH")).map((r) => r.venue).sort()).toEqual(["hyperliquid", "lighter-mainnet"]);
    // edge cases: a venue "0" liq price means none; a zero mark gives no distance
    expect(distancePct("2000", "0")).toBeNull();
    expect(distancePct("0", "1700")).toBeNull();
    expect(distancePct("100", "133.33333")).toBe(33.3333);
  });
});
