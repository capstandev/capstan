// R3 (copy rules, on this repo's own copy: the React pages and the live views) and R11 (prices match the routes).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCopy, copyProblems, renderAll, tickerProblems, visibleText } from "../scripts/check-copy";
import { PRICES } from "../src/copy";

// Bad phrases are assembled at run time: the repo's banned-word scan reads this file too.
const j = (...p: string[]) => p.join("");

describe("copy", () => {
  test("rules", async () => {
    const { problems, pages } = await checkCopy();
    expect(problems).toEqual([]);
    expect(pages).toBeGreaterThanOrEqual(12);

    // every rule fires on a planted sentence
    const planted: [string, RegExp][] = [
      [j("The offi", "cial Hyperliquid API."), /official/],
      [j("The fir", "st perps API."), /first/],
      [j("Use a V", "PN if you are refused."), /VPN/],
      [j("Cross", "-margin across venues."), /pooled-margin|banned/],
      [j("Shared colla", "teral for every account."), /pooled-margin|banned/],
      [j("A ", "risk", "-free trade."), /banned/],
      ["Lock CPST for perks.", /ticker/],
      ["Buy $CPST today.", /ticker/],
      ["A hedged funding trade.", /hedge/],
    ];
    for (const [s, rule] of planted) {
      const p = copyProblems(s, "planted");
      expect({ s, fired: p.some((x) => rule.test(x.rule)) }).toEqual({ s, fired: true });
    }
    // allowed forms pass
    expect(copyProblems(j("The fir", "st perps API with signed receipts (U)."), "ok")).toEqual([]);
    expect(copyProblems("Each venue liquidates independently. Nothing here is shared margin.", "banner")).toEqual([]);
    expect(copyProblems("Your receipts, newest first.", "order")).toEqual([]);
    expect(tickerProblems("Lock $CPST on Robinhood Chain for perks.")).toEqual([]);
    expect(copyProblems("Hedge failure policy At-risk. Legging risk is yours.", "hedge")).toEqual([]);
    // the banner allowlist is exact: a near copy still fails
    expect(copyProblems(j("Nothing here is sha", "red margin"), "near").length).toBeGreaterThan(0);
  });

  test("pricing-matches-routes", async () => {
    // the owner's pricing page starts at "From $0.01" per premium call: the cheapest priced route
    const owner = readFileSync(join(import.meta.dir, "../public/bloop-views.js"), "utf8");
    expect(owner).toContain("<strong>From $0.01</strong>");
    for (const p of await renderAll()) expect(visibleText(p.html).toLowerCase()).not.toContain("fills backfill");

    // each priced row is a priced route in the shipped OpenAPI file, at the same price
    const spec = JSON.parse(readFileSync(join(import.meta.dir, "../../apps/api/openapi.json"), "utf8")) as { paths: Record<string, Record<string, { "x-price-usd"?: string }>> };
    const priced = new Map<string, string>();
    for (const [path, ops] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(ops)) if (op["x-price-usd"] && !path.startsWith("/v1/credits")) priced.set(`${m.toUpperCase()} ${path}`, op["x-price-usd"]);
    const expected: Record<string, string> = {
      "GET /v1/funding/forecast": "0.01",
      "GET /v1/spreads/scan": "0.02",
      "POST /v1/risk/snapshot": "0.01",
      "GET /v1/risk/liq-heatmap": "0.02",
      "GET /v1/history/funding": "0.05",
    };
    expect(Object.fromEntries(priced)).toEqual(expected);
    const row = (s: string) => PRICES.find((p) => p.group.startsWith(s))!.price;
    expect(row("Funding forecast")).toBe("$0.01 per call");
    expect(row("Spread scanner")).toBe("$0.02 per call");
    expect(row("Risk snapshot")).toBe("$0.01 per call");
    expect(row("Liquidation heatmap")).toBe("$0.02 per call");
    expect(row("Historical funding (per 1,000 rows)")).toBe("$0.05");
    // no history route other than funding exists, so no other history row is priced
    expect(Object.keys(spec.paths).filter((p) => p.startsWith("/v1/history/"))).toEqual(["/v1/history/funding"]);
    expect(PRICES.filter((p) => /histor/i.test(p.group)).length).toBe(1);
  });
});
