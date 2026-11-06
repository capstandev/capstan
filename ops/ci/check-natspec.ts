// NatSpec gate: every public or external function of every contract in contracts/src (interfaces excluded: their
// implementations carry the docs) has a @notice. Reads `forge inspect <Contract> abi` and `userdoc`.
// Usage: bun ops/ci/check-natspec.ts [repoRoot]   (needs forge on PATH or at ~/.foundry/bin/forge)
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { walk } from "./lex";

export interface AbiItem {
  type: string;
  name?: string;
  inputs?: { type: string; components?: AbiItem["inputs"] }[];
}

function canonicalType(t: { type: string; components?: AbiItem["inputs"] }): string {
  if (t.type.startsWith("tuple")) return `(${(t.components ?? []).map(canonicalType).join(",")})${t.type.slice(5)}`;
  return t.type;
}

/** Functions in the ABI whose signature has no @notice in the userdoc. */
export function missingNotices(abi: AbiItem[], userdoc: { methods?: Record<string, { notice?: string }> }): string[] {
  const docs = userdoc.methods ?? {};
  return abi
    .filter((i) => i.type === "function" && i.name)
    .map((i) => `${i.name}(${(i.inputs ?? []).map(canonicalType).join(",")})`)
    .filter((sig) => !docs[sig]?.notice);
}

/** Contract names declared in non-interface source files under contracts/src. */
export function contractsIn(root: string): string[] {
  const names: string[] = [];
  for (const f of walk(root, "contracts/src", (r) => r.endsWith(".sol") && !r.includes("/interfaces/"))) {
    const src = readFileSync(join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const m of src.matchAll(/^\s*(?:abstract\s+)?contract\s+([A-Za-z_]\w*)/gm)) names.push(m[1]!);
  }
  return names.sort();
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, "../.."));
  const forge = existsSync(join(homedir(), ".foundry/bin/forge")) ? join(homedir(), ".foundry/bin/forge") : "forge";
  const problems: string[] = [];
  // Functions inherited unchanged from a vendored library (documented upstream with @dev): exact Contract.sig lines.
  const inheritedFile = join(root, "ops/ci/natspec-inherited.txt");
  const inherited = new Set(
    existsSync(inheritedFile)
      ? readFileSync(inheritedFile, "utf8").split("\n").map((l) => l.split("|")[0]!.trim()).filter((l) => l && !l.startsWith("#"))
      : [],
  );
  for (const c of contractsIn(root)) {
    const run = (what: string) => {
      const p = Bun.spawnSync([forge, "inspect", c, what, "--json"], { cwd: join(root, "contracts") });
      if (p.exitCode !== 0) throw new Error(`forge inspect ${c} ${what} failed: ${p.stderr.toString().slice(0, 400)}`);
      return JSON.parse(p.stdout.toString());
    };
    for (const sig of missingNotices(run("abi"), run("userdoc"))) if (!inherited.has(`${c}.${sig}`)) problems.push(`${c}.${sig} has no @notice`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`check-natspec: ${p}`);
    process.exit(1);
  }
  console.log("check-natspec: every public and external function has a @notice");
}
