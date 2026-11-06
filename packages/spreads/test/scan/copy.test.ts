// R7: every row carries the exact risk label and the observed note; no string says "hedged" without "legging risk is
// yours" next to it; the route output passes the banned-word scan.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OBSERVED_NOTE, scan } from "../../src";
import { REQ, setup } from "./helpers";

const ROOT = join(import.meta.dir, "../../../..");
const banned = readFileSync(join(ROOT, "ops/ci/banned-words.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => new RegExp(l, "i"));

describe("copy", () => {
  test("labels", async () => {
    const rows = await scan(REQ, setup().deps);
    expect(rows.length).toBeGreaterThan(2);
    for (const r of rows) {
      expect(r.riskLabel).toBe("At-risk. Legging risk is yours.");
      expect(r.observedNote).toBe(OBSERVED_NOTE);
      expect(r.observedNote).toBe("Observed, changes hourly.");
    }
    const out = JSON.stringify(rows);
    for (const re of banned) expect(out).not.toMatch(re);
    // source strings of the package: "hedged" only ever next to "legging risk is yours"
    const src = join(import.meta.dir, "../../src");
    for (const f of readdirSync(src)) {
      for (const line of readFileSync(join(src, f), "utf8").split("\n")) if (/(?<!un)hedged/i.test(line)) expect(line.toLowerCase(), f).toContain("legging risk is yours");
    }
    expect(out).not.toMatch(/(?<!un)hedged|guaranteed|arbitrage profit/i);
  });
});
