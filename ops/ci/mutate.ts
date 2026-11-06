// Scripted operator-swap mutation pass over the contracts (todo 25 R14, R20). For every code line of the target
// files it makes one-change mutants (comparison, arithmetic, logic, constant, revert-removal and statement-deletion
// operators), runs the Foundry suite against each in a scratch copy, and counts a mutant as killed when any test
// fails. Mutants that do not compile are "stillborn" and left out of the score. Survivors must be listed with a
// reason in ops/ci/mutation-equivalent.txt (one line: file | original | mutant | reason); an unexplained survivor or
// a score under 90% fails the run.
// Writes contracts/test/MUTATION.md (per-mutant results) and .audit-grade/mutation.md (killed/total per file).
// Usage: bun ops/ci/mutate.ts [--files a.sol,b.sol] [--limit N]
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface Mutant {
  file: string;
  line: number;
  op: string;
  original: string;
  mutated: string;
}

export const DEFAULT_TARGETS = ["src/CapstanReceiptAnchor.sol", "src/CPSTLock.sol", "src/libs/SortedPairMerkle.sol"];

const SWAPS: [RegExp, string, string][] = [
  [/ < /g, " <= ", "lt->le"],
  [/ <= /g, " < ", "le->lt"],
  [/ > /g, " >= ", "gt->ge"],
  [/ >= /g, " > ", "ge->gt"],
  [/ == /g, " != ", "eq->ne"],
  [/ != /g, " == ", "ne->eq"],
  [/ \+ /g, " - ", "add->sub"],
  [/ - /g, " + ", "sub->add"],
  [/ \+= /g, " -= ", "addassign->subassign"],
  [/ -= /g, " += ", "subassign->addassign"],
  [/ \* /g, " / ", "mul->div"],
  [/ \/ /g, " * ", "div->mul"],
  [/ \|\| /g, " && ", "or->and"],
  [/ && /g, " || ", "and->or"],
  [/\b30 days\b/g, "31 days", "const-30d"],
  [/\b90 days\b/g, "91 days", "const-90d"],
  [/\b3600\b/g, "3599", "const-hour"],
  [/\? \(a, b\) : \(b, a\)/g, "? (b, a) : (a, b)", "ternary-swap"],
  [/\bi < n\b/g, "i < n - 1", "loop-bound"],
  [/\bmsg\.sender\b/g, "tx.origin", "sender->origin"],
  [/\b_entered = 1;/g, "_entered = 0;", "guard-off"],
];

/** Code part of a Solidity line: everything before a // comment; empty for NatSpec and comment lines. */
export function codeOf(line: string): string {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
  const i = line.indexOf("//");
  return i >= 0 ? line.slice(0, i) : line;
}

/** Every one-change mutant of a source file. */
export function mutantsOf(file: string, src: string): Mutant[] {
  const out: Mutant[] = [];
  const lines = src.split("\n");
  lines.forEach((raw, idx) => {
    const code = codeOf(raw);
    if (!code.trim() || /^\s*(pragma|import|error|event)\b/.test(code)) return;
    for (const [re, rep, op] of SWAPS) {
      const matches = [...code.matchAll(re)];
      for (const m of matches) {
        const at = m.index ?? 0;
        const mutated = raw.slice(0, at) + code.slice(at).replace(m[0], rep);
        if (mutated !== raw) out.push({ file, line: idx + 1, op, original: raw, mutated });
      }
    }
    // remove a revert from `if (...) revert X(...);`
    const rv = code.match(/^(\s*if \(.*\)) revert .*;\s*$/);
    if (rv) out.push({ file, line: idx + 1, op: "drop-revert", original: raw, mutated: `${rv[1]} {}` });
    // delete a state-changing statement
    if (/^\s*(latestHour = |_roots\[|delete |totalLocked [+-]= |l\.amount \+= |l\.unlockAt = |emit |_call\(|h = hashPair)/.test(code) && code.trim().endsWith(";")) {
      out.push({ file, line: idx + 1, op: "drop-statement", original: raw, mutated: raw.replace(/\S.*$/, "// mutant: statement removed") });
    }
  });
  return out;
}

function runForge(dir: string): { compiled: boolean; failed: boolean } {
  const forge = existsSync(join(homedir(), ".foundry/bin/forge")) ? join(homedir(), ".foundry/bin/forge") : "forge";
  const env = { ...process.env, FOUNDRY_PROFILE: "mutation" };
  const b = spawnSync(forge, ["build"], { cwd: dir, env, encoding: "utf8" });
  if (b.status !== 0) return { compiled: false, failed: true };
  const t = spawnSync(forge, ["test", "--no-match-path", "test/fork/*", "--fail-fast"], { cwd: dir, env, encoding: "utf8" });
  return { compiled: true, failed: t.status !== 0 };
}

export function loadEquivalent(text: string): { file: string; original: string; mutated: string; reason: string }[] {
  return text
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => {
      const [file, original, mutated, reason] = l.split(" | ").map((x) => x.trim());
      return { file: file ?? "", original: original ?? "", mutated: mutated ?? "", reason: reason ?? "" };
    });
}

if (import.meta.main) {
  const root = resolve(join(import.meta.dir, "../.."));
  const args = process.argv.slice(2);
  const fi = args.indexOf("--files");
  const targets = fi >= 0 ? (args[fi + 1] ?? "").split(",") : DEFAULT_TARGETS;
  const li = args.indexOf("--limit");
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  const equivalent = loadEquivalent(readFileSync(join(root, "ops/ci/mutation-equivalent.txt"), "utf8"));

  const work = mkdtempSync(join(tmpdir(), "capstan-mutation-"));
  const wc = join(work, "contracts");
  cpSync(join(root, "contracts"), wc, { recursive: true, filter: (s) => !s.includes("/broadcast") && !s.endsWith("/deployments/local") });
  symlinkSync(join(root, "packages"), join(work, "packages"));
  const base = runForge(wc);
  if (!base.compiled || base.failed) {
    console.error("mutation: the unmutated suite does not pass; fix it first");
    process.exit(1);
  }

  const results: (Mutant & { status: "killed" | "survived" | "stillborn"; reason?: string })[] = [];
  for (const file of targets) {
    const path = join(wc, file);
    const src = readFileSync(path, "utf8");
    const ms = mutantsOf(file, src).slice(0, limit);
    for (const m of ms) {
      const lines = src.split("\n");
      lines[m.line - 1] = m.mutated;
      writeFileSync(path, lines.join("\n"));
      const r = runForge(wc);
      const status = !r.compiled ? "stillborn" : r.failed ? "killed" : "survived";
      const eq = equivalent.find((e) => e.file === m.file && e.original === m.original.trim() && e.mutated === m.mutated.trim());
      results.push({ ...m, status, reason: eq?.reason });
      console.log(`${status.padEnd(9)} ${file}:${m.line} ${m.op}`);
    }
    writeFileSync(path, src);
  }
  rmSync(work, { recursive: true, force: true });

  const per = new Map<string, { killed: number; total: number; stillborn: number }>();
  for (const r of results) {
    const p = per.get(r.file) ?? { killed: 0, total: 0, stillborn: 0 };
    if (r.status === "stillborn") p.stillborn++;
    else {
      p.total++;
      if (r.status === "killed") p.killed++;
    }
    per.set(r.file, p);
  }
  const killed = [...per.values()].reduce((a, p) => a + p.killed, 0);
  const total = [...per.values()].reduce((a, p) => a + p.total, 0);
  const score = total ? (100 * killed) / total : 0;
  const survivors = results.filter((r) => r.status === "survived");
  const unexplained = survivors.filter((r) => !r.reason);
  const date = new Date().toISOString().slice(0, 10);

  const table = ["| File | Killed | Total (compiled) | Stillborn | Score |", "| --- | --- | --- | --- | --- |"];
  for (const [f, p] of per) table.push(`| \`contracts/${f}\` | ${p.killed} | ${p.total} | ${p.stillborn} | ${p.total ? ((100 * p.killed) / p.total).toFixed(1) : "n/a"}% |`);
  table.push(`| **All** | **${killed}** | **${total}** | | **${score.toFixed(1)}%** |`);

  const md: string[] = [
    "# Mutation results (contracts)",
    "",
    `Generated by \`bash ops/ci/mutation.sh\` on ${date}. Scripted operator-swap pass (comparison, arithmetic, logic, constant,`,
    "revert-removal and statement-deletion operators) over the contract sources; a mutant is killed when any Foundry test",
    "fails (fork tests excluded). Stillborn mutants do not compile and are not scored. Target: 90% or more.",
    "",
    ...table,
    "",
    "## Survivors and why they are equivalent or accepted",
    "",
    survivors.length ? "| File:line | Operator | Mutant | Reason |" : "No mutant survived.",
    ...(survivors.length ? ["| --- | --- | --- | --- |"] : []),
    ...survivors.map((s) => `| \`${s.file}:${s.line}\` | ${s.op} | \`${s.mutated.trim().replace(/\|/g, "\\|")}\` | ${s.reason ?? "UNEXPLAINED"} |`),
    "",
    "## Every mutant",
    "",
    "| File:line | Operator | Result |",
    "| --- | --- | --- |",
    ...results.map((r) => `| \`${r.file}:${r.line}\` | ${r.op} | ${r.status} |`),
    "",
  ];
  writeFileSync(join(root, "contracts/test/MUTATION.md"), md.join("\n"));
  mkdirSync(join(root, ".audit-grade"), { recursive: true });
  writeFileSync(
    join(root, ".audit-grade/mutation.md"),
    [
      "# Mutation score (contracts)",
      "",
      `Evidence for the audit rubric (TEST: mutation). Generated by \`bash ops/ci/mutation.sh\` on ${date}; per-mutant`,
      "results and survivor reasons are in `contracts/test/MUTATION.md`.",
      "",
      ...table,
      "",
    ].join("\n"),
  );
  console.log(`mutation: ${killed}/${total} killed (${score.toFixed(1)}%), ${survivors.length} survived, ${unexplained.length} unexplained`);
  if (score < 90 || unexplained.length) process.exit(1);
}
