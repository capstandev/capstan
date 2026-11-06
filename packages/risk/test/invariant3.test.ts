// R1 (invariant 3): no type in this package and no key of 100 built views sums or nets collateral, equity or margin
// across venues, and no field names pooled margin.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VenueId } from "@capstan/schema";
import { buildRiskView, liqHeatmap } from "../src";
import { CATALOG, NOW, OWNER, pos, snap } from "./helpers";
import { fixtureReader, rhSnapshot, USER_A } from "./recorded";

const POOLED = /total(Equity|Collateral|Margin)|net(Collateral|Margin)|shared|crossVenue/i;

function keys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) out.push(k), keys(x, out);
  return out;
}

describe("invariant 3", () => {
  test("no-cross-venue-aggregate", async () => {
    // type-level walk: every interface, type and property name exported from the package sources
    let names = 0;
    for (const f of readdirSync(join(import.meta.dir, "../src"))) {
      const code = readFileSync(join(import.meta.dir, "../src", f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*[?]?:/g)) (names++, expect(`${f}: ${m[1]}`).not.toMatch(POOLED));
      for (const m of code.matchAll(/(?:interface|type|function|const)\s+([A-Za-z_$][\w$]*)/g)) (names++, expect(`${f}: ${m[1]}`).not.toMatch(POOLED));
    }
    expect(names).toBeGreaterThan(50);
    // 100 built views from random positions on every executable venue, plus the recorded HL and Lighter-RH accounts
    const { reader } = fixtureReader();
    const hl = await reader.getAccount({ venue: "hyperliquid", owner: USER_A });
    const rh = rhSnapshot();
    let seed = 7;
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const venues: VenueId[] = ["hyperliquid", "lighter-mainnet", "lighter-rh", "aster"];
    const markets: Record<string, string> = { hyperliquid: "hyperliquid:-:ETH", "lighter-mainnet": "lighter-mainnet:-:ETH", "lighter-rh": "lighter-rh:-:HYPE", aster: "aster:-:ETHUSDT" };
    for (let i = 0; i < 100; i++) {
      const snaps = venues.filter(() => r() < 0.7).map((v) => snap(v, [pos(v, markets[v]!, { side: r() < 0.5 ? "long" : "short", notionalUsd: String(Math.floor(r() * 10000)), liqPx: r() < 0.2 ? null : String(1000 + Math.floor(r() * 2000)) })], { equityUsd: String(Math.floor(r() * 5000)) }));
      if (i % 10 === 0) snaps.push(hl, rh);
      const view = await buildRiskView(OWNER, snaps.map((s) => s.identity), snaps, new Map(), CATALOG, NOW);
      for (const k of keys(view)) expect(k).not.toMatch(POOLED);
      // the per-venue equity figures are exactly the venue's own, and no other equity figure exists in the view
      expect(view.perVenue.map((s) => s.equityUsd)).toEqual(snaps.map((s) => s.equityUsd));
      expect(keys(view).filter((k) => /equity/i.test(k)).length).toBe(view.perVenue.length);
    }
    for (const k of keys(liqHeatmap("CR:ETH", [{ venue: "hyperliquid", marketId: "hyperliquid:-:ETH", liqPx: "1", markPx: "1.01", notionalUsd: "1" }]))) expect(k).not.toMatch(POOLED);
  });
});
