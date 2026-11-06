// R8: no string in the plans package, its routes or its jobs says CPST earns, pays or returns anything. Perks are
// "higher limits" and "a lower integration fee". Checks every string literal against the banned-word list plus a
// phrase list (revenue share, dividend, yield, earn, pays you, returns, profit, passive income, interest).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lex } from "../../../ops/ci/lex";
import { PERK_COPY } from "../src/tiers";

const ROOT = join(import.meta.dir, "../../..");
const FILES = [
  ...readdirSync(join(ROOT, "packages/tiers/src")).map((f) => `packages/tiers/src/${f}`),
  "apps/api/src/routes/account.routes.ts",
  "apps/api/src/routes/credits.routes.ts",
  "apps/workers/src/jobs/lock-snapshot.job.ts",
  "apps/workers/src/jobs/staker-credits.job.ts",
  "ops/governance/export-poll.ts",
];
export const REVENUE_PHRASES = [/revenue[- ]share/i, /\bdividends?\b/i, /\byields?\b/i, /\bearn(s|ed|ing|ings)?\b/i, /\bpays? you\b/i, /\breturns?\b/i, /\bprofits?\b/i, /passive income/i, /\binterest\b/i, /\breward(s|ed)?\b/i];

function banned(): RegExp[] {
  return readFileSync(join(ROOT, "ops/ci/banned-words.txt"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => new RegExp(l, "i"));
}

describe("plans copy", () => {
  test("no-revenue-claims", () => {
    const rules = [...REVENUE_PHRASES, ...banned()];
    const hits: string[] = [];
    let strings = 0;
    for (const f of FILES) {
      const { strings: ss } = lex(readFileSync(join(ROOT, f), "utf8"));
      for (const s of ss) {
        strings++;
        if (/^(function|event) \w+\(/.test(s.value)) continue; // Solidity ABI fragments are code, not copy
        for (const r of rules) if (r.test(s.value)) hits.push(`${f}:${s.line} "${s.value}" matches ${r}`);
      }
    }
    expect(strings).toBeGreaterThan(50);
    expect(hits).toEqual([]);
    // the perks say limits and fees only
    for (const t of ["lock_holder", "lock_whale"] as const) {
      expect(PERK_COPY[t]).toContain("higher limits");
      expect(PERK_COPY[t]).toContain("a lower integration fee");
    }
    // the scanner itself catches a claim
    expect(rules.some((r) => r.test("Lock CPST to earn a revenue share"))).toBe(true);
  });
});
