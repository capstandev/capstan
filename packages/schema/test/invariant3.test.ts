// R5 (invariant 3): nothing in the schema pools collateral across venues; RiskView.perVenue is an array of per-venue
// snapshots, never one merged object.
import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AccountSnapshot, RiskView } from "../src/core";
import { RISK_BANNER } from "../src/core";
import { ALL_TABLES } from "../src/db";

const POOLED = /shared_?margin|net_?collateral|cross_?venue|pooled_?collateral|unified_?margin|combined_?margin/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("invariant 3", () => {
  test("no-shared-margin", () => {
    // no table or column
    for (const t of Object.values(ALL_TABLES)) {
      const cfg = getTableConfig(t);
      expect(cfg.name).not.toMatch(POOLED);
      for (const c of cfg.columns) expect(`${cfg.name}.${c.name}`).not.toMatch(POOLED);
    }
    // no field or type name in the schema sources (comments are allowed to explain the rule)
    for (const f of files(join(import.meta.dir, "../src"))) {
      const code = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*[?]?:/g)) expect(`${f}: ${m[1]}`).not.toMatch(POOLED);
      for (const m of code.matchAll(/(?:interface|type)\s+([A-Za-z_$][\w$]*)/g)) expect(`${f}: ${m[1]}`).not.toMatch(POOLED);
    }
  });

  test("RiskView.perVenue is an array of per-venue AccountSnapshots with the fixed banner", () => {
    const snap = (venue: AccountSnapshot["venue"]): AccountSnapshot => ({
      venue,
      identity: { venue, owner: "0x0000000000000000000000000000000000000001" },
      equityUsd: "1",
      freeCollateralUsd: "1",
      positions: [],
      asOf: "t",
    });
    const view: RiskView = {
      owner: null,
      addresses: [],
      perVenue: [snap("hyperliquid"), snap("aster")],
      exposureByAsset: [],
      liquidationLadder: [],
      stress: [],
      banner: RISK_BANNER,
      asOf: "t",
    };
    expect(Array.isArray(view.perVenue)).toBe(true);
    expect(view.perVenue.map((s) => s.venue)).toEqual(["hyperliquid", "aster"]);
    // @ts-expect-error a single merged snapshot does not type-check
    const merged: RiskView = { ...view, perVenue: snap("hyperliquid") };
    // @ts-expect-error the banner is a fixed literal
    const reworded: RiskView = { ...view, banner: "Margin is shared." };
    expect(merged && reworded).toBeTruthy();
    expect(RISK_BANNER).toBe("Each venue liquidates independently. Nothing here is shared margin.");
  });
});
