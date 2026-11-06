import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertCausesKnown, CAUSES, loadGlossary, parseGlossary, UnknownCauseError } from "../src";

const ROOT = join(import.meta.dir, "..", "..", "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "test") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (n.endsWith(".ts") && !n.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("glossary", () => {
  test("complete: every alert cause used in code has a GLOSSARY.md entry, and the worker refuses unknown causes", () => {
    const g = loadGlossary();
    expect(() => assertCausesKnown(Object.keys(CAUSES), g)).not.toThrow();
    // every ops event kind raised anywhere in apps/ and packages/ (files that publish ops events) is a known cause
    const used = new Set<string>();
    for (const f of [...sources(join(ROOT, "apps")), ...sources(join(ROOT, "packages"))]) {
      const t = readFileSync(f, "utf8");
      const isProducer = /OPS_ALERT_CHANNEL|emitOpsEvent|"ops\.alert"|kind: "x402\.float_above_limit"/.test(t) || f.includes("packages/telemetry/src/monitors");
      if (!isProducer) continue;
      for (const m of t.matchAll(/kind: "([a-z0-9_]+\.[a-z0-9_.]+)"/g)) used.add(m[1]!);
    }
    for (const k of ["catalog.new_dexes", "anchor.root_mismatch", "lighter_rh.deposit_pin_mismatch", "quote.stale_t1", "builder.hl_low"]) expect(used.has(k)).toBeTrue();
    const missing = [...used].filter((k) => !(k in CAUSES) || !g.has(k));
    expect(missing).toEqual([]);
    // every glossary entry is a cause in code too (no dead entries)
    expect([...g.keys()].filter((c) => !(c in CAUSES))).toEqual([]);
    expect(() => assertCausesKnown(["nope.missing"], g)).toThrow(UnknownCauseError);
  });

  test("glossary entries have a severity, a meaning and an action; no private names", () => {
    const text = readFileSync(join(ROOT, "ops/alerts/GLOSSARY.md"), "utf8");
    const g = parseGlossary(text);
    for (const e of g.values()) {
      expect(["info", "act", "critical"]).toContain(e.severity);
      expect(e.means.length).toBeGreaterThan(10);
      expect(e.todo.length).toBeGreaterThan(5);
    }
    expect(() => parseGlossary("## bad name\nSeverity: act\nMeans: x\nDo: y\n")).toThrow();
    expect(() => parseGlossary("## a.b\nSeverity: loud\nMeans: x\nDo: y\n")).toThrow();
  });
});
