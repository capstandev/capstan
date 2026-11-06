// R2 banner always, R3 one entry per venue identity (HL dexes stay separate inside the HL snapshot with their own
// collateral), R7 no unit multiplier applied to venue-reported Lighter-RH values.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RISK_BANNER } from "@capstan/schema";
import { BANNER, buildRiskView } from "../src";
import { CATALOG, NOW, OWNER, pos, snap } from "./helpers";
import { fixtureReader, rhRaw, rhSnapshot, USER_A } from "./recorded";

describe("risk view", () => {
  test("banner-always", async () => {
    expect(BANNER).toBe("Each venue liquidates independently. Nothing here is shared margin.");
    expect(BANNER).toBe(RISK_BANNER);
    const empty = await buildRiskView(null, [], [], new Map(), CATALOG, NOW);
    expect(empty.banner).toBe(BANNER);
    expect(empty.perVenue).toEqual([]);
    const full = await buildRiskView(OWNER, [], [snap("hyperliquid", [pos("hyperliquid", "hyperliquid:-:ETH")])], new Map(), CATALOG, NOW, { pending: [{ venue: "aster", identity: { venue: "aster", owner: OWNER }, status: "needs_signed_read", reason: "r" }] });
    expect(full.banner).toBe(BANNER);
    expect(JSON.parse(JSON.stringify(full)).banner).toBe(BANNER);
  });

  test("per-venue", async () => {
    const { reader } = fixtureReader();
    const hl = await reader.getAccount({ venue: "hyperliquid", owner: USER_A });
    const rh = rhSnapshot();
    const lm = snap("lighter-mainnet", [pos("lighter-mainnet", "lighter-mainnet:-:ETH")]);
    const ids = [hl.identity, rh.identity, lm.identity];
    const v = await buildRiskView(USER_A, ids, [hl, rh, lm], new Map(), CATALOG, NOW);
    // one snapshot per venue identity, in order, never merged
    expect(v.perVenue.length).toBe(3);
    expect(v.perVenue.map((s) => s.venue)).toEqual(["hyperliquid", "lighter-rh", "lighter-mainnet"]);
    expect(v.perVenue.map((s) => s.equityUsd)).toEqual([hl.equityUsd, rh.equityUsd, lm.equityUsd]);
    // HL: core and each HIP-3 dex are their own entries inside the HL snapshot, each with its own collateral asset
    const perDex = (v.perVenue[0] as unknown as { perDex: { dex: string | null; collateralAsset: string; accountValue: string; positions: { marketId: string }[] }[] }).perDex;
    expect(perDex.map((x) => x.dex)).toEqual([null, "xyz", "para", "mkts", "io"]);
    for (const x of perDex) {
      expect(typeof x.collateralAsset).toBe("string");
      expect(x.positions.every((p) => p.marketId.startsWith(`hyperliquid:${x.dex ?? "-"}:`))).toBe(true);
    }
    expect(perDex.map((x) => x.accountValue)).toEqual(["17628.233483", "220679.97471", "0.0", "0.0", "5141.858692"]);
    // the top-level HL equity is the core dex's own figure, never a sum of dexes
    expect(v.perVenue[0]!.equityUsd).toBe("17628.233483");
    // canonical assets are filled from the catalog without touching venue values
    const btc = v.perVenue[0]!.positions.find((p) => p.marketId === "hyperliquid:-:BTC")!;
    expect(btc.canonicalAsset).toBe("CR:BTC");
    expect(btc.liqPx).toBe("2076447.1443734928");
  });

  test("no-multiplier", async () => {
    // grep: nothing in this package reads or applies a unit multiplier
    const src = join(import.meta.dir, "../src");
    for (const f of readdirSync(src)) expect(readFileSync(join(src, f), "utf8"), f).not.toMatch(/uiMultiplier|multiplier\s*[*x]|\*\s*multiplier/i);
    // fixture: the recorded Lighter-RH HYPE short keeps the venue's own numbers end to end
    const raw = rhRaw();
    const hype = raw.positions!.find((p) => p.symbol === "HYPE")!;
    const rh = rhSnapshot();
    const v = await buildRiskView(rh.identity.owner, [rh.identity], [rh], new Map(), CATALOG, NOW);
    const p = v.perVenue[0]!.positions.find((x) => x.marketId === "lighter-rh:-:HYPE")!;
    expect(p.liqPx).toBe(hype.liquidation_price!);
    expect(p.entryPx).toBe(hype.avg_entry_price);
    expect(Number(p.notionalUsd)).toBe(Math.abs(Number(hype.position_value)));
    expect(p.collateralAsset).toBe("USDG");
    expect(v.perVenue[0]!.equityUsd).toBe(rh.equityUsd);
    const row = v.liquidationLadder.find((r) => r.marketId === "lighter-rh:-:HYPE")!;
    expect(row.liqPx).toBe(hype.liquidation_price!);
    expect(v.exposureByAsset.find((e) => e.canonicalAsset === "CR:HYPE")!.grossUsd).toBe(p.notionalUsd);
  });
});
