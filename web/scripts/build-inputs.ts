// The files outside web/ that `bun run build` reads: every workspace package the site imports (followed through
// relative and @capstan/* imports file by file, type-only ones too, from web/src, web/scripts and web/test, since the
// build typechecks all three), plus the files the build scripts read by path. scripts/ignore-build.sh must rebuild when any of them changes; test/vercel.test.ts holds it to this
// list. Usage: bun scripts/build-inputs.ts   (prints the top-level paths, one per line)
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const WEB = resolve(import.meta.dir, "..");
const REPO = resolve(WEB, "..");

/** Read by path, not imported: sync-openapi.ts, check-dist.ts, the tsconfig chain, and the root install (vercel.json
 *  installCommand installs the workspace root, so its manifest and lockfile change what the packages build with). */
export const READ_BY_PATH = ["apps/api/openapi.json", "apps/mcp/README.md", ".githooks/public-guard.denylist", "tsconfig.base.json", "package.json", "bun.lock"];

const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|new URL\(\s*)["']([^"']+)["']/g;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "dist" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(m?[jt]sx?)$/.test(n)) out.push(p);
  }
  return out;
}

/** The workspace folder (packages/x or packages/a/b) that holds a file, or null when it is not in one. */
function workspaceOf(file: string): string | null {
  for (let d = dirname(file); d.startsWith(REPO) && d !== REPO; d = dirname(d)) {
    if (existsSync(join(d, "package.json"))) return relative(REPO, d);
  }
  return null;
}

/** Workspace folders outside web/ that hold a file the site's code imports, directly or through other files. */
export function importedWorkspaces(): string[] {
  const seen = new Set<string>();
  const queue = [...sources(join(WEB, "src")), ...sources(join(WEB, "scripts")), ...sources(join(WEB, "test")), join(WEB, "vite.config.ts")];
  const done = new Set<string>();
  while (queue.length) {
    const f = queue.pop()!;
    if (done.has(f)) continue;
    done.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(SPEC)) {
      const spec = m[1]!;
      if (!spec.startsWith(".") && !spec.startsWith("@capstan/")) continue;
      let target: string;
      try {
        target = realpathSync(Bun.resolveSync(spec, dirname(f)));
      } catch {
        continue;
      }
      if (!target.startsWith(REPO + "/") || target.includes("/node_modules/")) continue;
      if (/\.(m?[jt]sx?)$/.test(target)) queue.push(target);
      if (target.startsWith(WEB + "/")) continue;
      const ws = workspaceOf(target);
      if (ws) seen.add(ws);
    }
  }
  return [...seen].sort();
}

export function buildInputs(): string[] {
  return [...importedWorkspaces(), ...READ_BY_PATH].sort();
}

if (import.meta.main) console.log(buildInputs().join("\n"));
