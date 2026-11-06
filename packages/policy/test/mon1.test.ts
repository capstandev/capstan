// R9 (MON-1): monitors never auto-kill. No monitor or job in the code base calls kill(); only the kill route (owner or
// agent signature) and this package's tests do.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const ALLOWED = new Set(["apps/api/src/routes/agents.routes.ts"]);

function files(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    if (n === "node_modules" || n.startsWith(".")) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js|mjs)$/.test(n) ? [p] : [];
  });
}

/** Calls of a kill method: `.kill(` on a kill switch, the Redis flag key or a direct SET of it. */
const KILL_CALL = /\.kill\s*\(|["'`]kill:\$\{|["'`]kill:["'`]\s*\+|killKey\s*\(/;

describe("MON-1", () => {
  test("no-auto-kill", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const top of ["apps", "packages"]) {
      for (const f of files(join(ROOT, top))) {
        const rel = relative(ROOT, f);
        if (rel.startsWith("packages/policy/")) continue; // the switch itself and its tests
        // the SDK is the user's side: its kill() sends the owner's or the agent's own signed kill to the route
        if (rel.startsWith("packages/sdk/")) continue;
        if (ALLOWED.has(rel)) continue;
        if (/^apps\/api\/test\/agents\.routes\.test\.ts$/.test(rel)) continue;
        scanned++;
        const code = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        // child processes and browsers have their own kill(); only kill-switch calls matter
        for (const line of code.split("\n")) {
          if (!KILL_CALL.test(line)) continue;
          if (/\b(proc|child|process|subprocess|browser|page|worker|server|anvil|p)\s*\.kill\s*\(/.test(line)) continue;
          offenders.push(`${rel}: ${line.trim().slice(0, 120)}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
    // and the route that may kill really is the agents route with signature auth
    const route = readFileSync(join(ROOT, "apps/api/src/routes/agents.routes.ts"), "utf8");
    expect(route).toContain("verifyKillAuth");
  });
});
