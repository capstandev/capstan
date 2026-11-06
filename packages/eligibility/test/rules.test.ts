// R8: rules are versioned and tighten-only. A stricter v2 may add countries; a loosening needs a source dated after
// the version it loosens; a stored v2 is what decisions use.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { checkRuleSet, decide, installRules, RuleError, RULES_V1, rulesInForce, storedRules, validateRuleUpgrade, type EligibilityRule } from "../src";
import { dbFixture, geo, IP, NOW, PG, REAL_NOW, wallet, type DbFixture } from "./helpers";

const v2 = (edit: (r: EligibilityRule) => EligibilityRule): EligibilityRule[] => RULES_V1.map((r) => edit({ ...structuredClone(r), version: 2 }));

describe("rule validator", () => {
  test("tighten-only", () => {
    checkRuleSet(RULES_V1, REAL_NOW());
    // stricter: add a country, same source date: fine
    validateRuleUpgrade(RULES_V1, v2((r) => (r.venue === "aster" ? { ...r, refusedCountries: [...r.refusedCountries, "BY"] } : r)), REAL_NOW());
    // loosening without a newer source: refused, for countries, regions, equity lists and the data-only flag
    const loosenings: [string, (r: EligibilityRule) => EligibilityRule][] = [
      ["country", (r) => (r.venue === "hyperliquid" ? { ...r, refusedCountries: r.refusedCountries.filter((c) => c !== "GB") } : r)],
      ["region", (r) => (r.venue === "aster" ? { ...r, extra: { ...r.extra, refusedRegions: [] } } : r)],
      ["equity", (r) => (r.venue === "hyperliquid" ? { ...r, extra: { ...r.extra, refuseForEquity: [] } } : r)],
      ["data-only", (r) => (r.venue === "arcus" ? { ...r, extra: { ...r.extra, dataOnly: false } } : r)],
    ];
    for (const [name, edit] of loosenings) {
      expect(() => validateRuleUpgrade(RULES_V1, v2(edit), REAL_NOW()), name).toThrow(RuleError);
      expect(() => validateRuleUpgrade(RULES_V1, v2(edit), REAL_NOW()), name).toThrow("without a source dated after 2026-11-05");
      // the same loosening with a newer dated source passes
      validateRuleUpgrade(RULES_V1, v2((r) => { const n = edit(r); return n !== r && JSON.stringify(n) !== JSON.stringify({ ...r }) ? { ...n, sourceDate: "2026-11-06", source: "dated legal note" } : n; }), REAL_NOW());
    }
    // version must go up; every venue needs a rule; codes must be well formed; no future source dates
    expect(() => validateRuleUpgrade(RULES_V1, RULES_V1, REAL_NOW())).toThrow("must be higher");
    expect(() => checkRuleSet(RULES_V1.filter((r) => r.venue !== "aster"), REAL_NOW())).toThrow("aster has no rule");
    expect(() => checkRuleSet(v2((r) => ({ ...r, refusedCountries: [...r.refusedCountries, "usa"] })), REAL_NOW())).toThrow("bad country code");
    expect(() => checkRuleSet(v2((r) => ({ ...r, sourceDate: "2027-01-01" })), REAL_NOW())).toThrow("in the future");
    expect(() => checkRuleSet([...RULES_V1, RULES_V1[0]!], REAL_NOW())).toThrow("listed twice");
  });
});

describe.skipIf(!PG)("stored rules", () => {
  let f: DbFixture;
  const owner = wallet("rules-owner");
  beforeAll(async () => {
    f = await dbFixture("rules");
  });
  afterAll(() => f?.drop());

  test("install v1, refuse a loosening v2, use a stricter v2", async () => {
    expect(await storedRules(f.db)).toBeNull();
    expect((await rulesInForce(f.db, NOW))[0]!.version).toBe(1); // compiled set when the table is empty
    expect(await installRules(f.db, RULES_V1, REAL_NOW())).toEqual({ version: 1, installed: true });
    expect(await installRules(f.db, RULES_V1, REAL_NOW())).toEqual({ version: 1, installed: false });
    const byVenue = (xs: EligibilityRule[]) => [...xs].sort((a, b) => a.venue.localeCompare(b.venue));
    expect(byVenue((await storedRules(f.db))!)).toEqual(byVenue(RULES_V1));
    const loose = v2((r) => (r.venue === "hyperliquid" ? { ...r, refusedCountries: r.refusedCountries.filter((c) => c !== "US") } : r));
    await expect(installRules(f.db, loose, REAL_NOW())).rejects.toThrow(RuleError);
    const strict = v2((r) => (r.venue === "aster" ? { ...r, refusedCountries: [...r.refusedCountries, "SG"] } : r));
    await installRules(f.db, strict, REAL_NOW());
    await f.declare(owner, ["aster"]);
    const d = await decide({ ip: IP.SG!, owner: owner.address, venue: "aster", action: "order" }, { geo, db: f.db, now: () => new Date(NOW) });
    expect(d).toMatchObject({ allowed: false, code: "GEO_REFUSED", rulesVersion: 2 });
    // a DE caller now needs a declaration that lists SG too: the v1-era one no longer covers aster
    expect(await decide({ ip: IP.DE!, owner: owner.address, venue: "aster", action: "order" }, { geo, db: f.db, now: () => new Date(NOW) })).toMatchObject({ allowed: false, code: "DECLARATION_MISSING" });
  });
});
