// R8: the server never executes. No module under apps/ imports the executor, and the package's main entry does not
// export it (only the SDK and MCP hosts load it by its own path).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as main from "../../src";

const ROOT = join(import.meta.dir, "../../../..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === "node_modules" || n.startsWith(".")) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js|mjs)$/.test(n) ? [p] : [];
  });
}

describe("server never executes", () => {
  test("client-only", () => {
    expect("execute" in main).toBe(false);
    const offenders: string[] = [];
    let scanned = 0;
    for (const f of files(join(ROOT, "apps"))) {
      const t = readFileSync(f, "utf8");
      scanned++;
      if (/spreads\/src\/executor|from\s+["']@capstan\/spreads\/executor["']/.test(t)) offenders.push(relative(ROOT, f));
      if (/import\s*\{[^}]*\bexecute\b[^}]*\}\s*from\s*["']@capstan\/spreads/.test(t)) offenders.push(relative(ROOT, f));
      if (/@capstan\/sdk/.test(t) && /executeSpreadPlan/.test(t)) offenders.push(relative(ROOT, f));
    }
    expect(scanned).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
    // the executor module itself imports nothing server-side
    const ex = readFileSync(join(import.meta.dir, "../../src/executor.ts"), "utf8");
    const imports = [...ex.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["@capstan/schema"]);
  });
});
