// Dependency and action pin check (DEPS-1..4): every dependency in every package.json is an exact version (no ^, ~,
// ranges, tags or URLs; `workspace:*` for our own packages), every workflow `uses:` is a full 40-hex commit sha, and
// every workflow container image carries an @sha256 digest.
// Usage: bun ops/ci/check-pins.ts [repoRoot]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { walk } from "./lex";

export interface PinProblem {
  file: string;
  line?: number;
  what: string;
}

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function checkPackageJson(file: string, text: string): PinProblem[] {
  const out: PinProblem[] = [];
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [{ file, what: "not valid JSON" }];
  }
  for (const field of DEP_FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, ver] of Object.entries(deps)) {
      if (ver === "workspace:*" && name.startsWith("@capstan/")) continue;
      if (field === "peerDependencies" && EXACT.test(ver)) continue;
      if (!EXACT.test(ver)) out.push({ file, what: `${field}.${name} is "${ver}", not an exact version` });
    }
  }
  return out;
}

export function checkWorkflow(file: string, text: string): PinProblem[] {
  const out: PinProblem[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "");
    const uses = /^[\s-]*uses:\s*(\S+)/.exec(line);
    if (uses) {
      const ref = uses[1]!.replace(/^["']|["']$/g, "");
      if (!ref.startsWith("./") && !/@[0-9a-f]{40}$/.test(ref)) out.push({ file, line: i + 1, what: `action not pinned by full sha: ${ref}` });
    }
    const img = /^[\s-]*(image|container):\s*(\S+)/.exec(line);
    if (img && img[2] && !img[2].endsWith(":") && !/@sha256:[0-9a-f]{64}/.test(img[2])) out.push({ file, line: i + 1, what: `image not pinned by digest: ${img[2]}` });
    const dk = /docker:\/\/(\S+)/.exec(line);
    if (dk && !/@sha256:[0-9a-f]{64}/.test(dk[1]!)) out.push({ file, line: i + 1, what: `image not pinned by digest: ${dk[1]}` });
  });
  return out;
}

export function findPinProblems(root: string): PinProblem[] {
  const out: PinProblem[] = [];
  for (const f of walk(root, ".", (rel) => rel === "package.json" || rel.endsWith("/package.json"))) {
    if (f.startsWith("contracts/lib/")) continue;
    out.push(...checkPackageJson(f, readFileSync(join(root, f), "utf8")));
  }
  for (const f of walk(root, ".github/workflows", (rel) => /\.ya?ml$/.test(rel))) out.push(...checkWorkflow(f, readFileSync(join(root, f), "utf8")));
  for (const f of walk(root, ".", (rel) => rel === "bunfig.toml" || rel.endsWith("/bunfig.toml"))) out.push(...checkBunfig(f, readFileSync(join(root, f), "utf8")));
  return out;
}

/** The supply-chain delay every install must keep, in seconds (3 days). */
export const MIN_RELEASE_AGE_S = 259200;

/**
 * Bun reads the bunfig.toml of the folder it runs in, so a package with its own (web/) does not inherit the root's
 * install rules (r1:9 F-5). Each one must keep exact versions and the 3-day delay itself.
 */
function checkBunfig(file: string, text: string): PinProblem[] {
  const install = text.split(/^\[/m).find((sec) => sec.startsWith("install]")) ?? "";
  const out: PinProblem[] = [];
  if (!/^exact\s*=\s*true\s*$/m.test(install)) out.push({ file, what: "no [install] exact = true" });
  const age = install.match(/^minimumReleaseAge\s*=\s*(\d+)\s*$/m);
  if (!age || Number(age[1]) < MIN_RELEASE_AGE_S) out.push({ file, what: `no [install] minimumReleaseAge of at least ${MIN_RELEASE_AGE_S} seconds` });
  return out;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, "../.."));
  const problems = findPinProblems(root);
  if (problems.length) {
    for (const p of problems) console.error(`check-pins: ${p.file}${p.line ? `:${p.line}` : ""}: ${p.what}`);
    console.error(`check-pins: ${problems.length} problem(s).`);
    process.exit(1);
  }
  console.log("check-pins: every dependency exact, every action by sha, every image by digest");
}
