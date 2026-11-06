// Runs slither over contracts/src and fails on any finding not listed in ops/ci/slither-allow.txt.
// Usage (CI): bun ops/ci/run-slither.ts   (slither must be on PATH; installed from ops/ci/slither-requirements.txt)
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface SlitherFinding {
  check: string;
  contract: string;
  fn: string;
  description: string;
}

export function loadAllow(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("|").slice(0, 3).map((s) => s.trim()).join("|")),
  );
}

export function parseSlither(json: unknown): SlitherFinding[] {
  const dets = ((json as { results?: { detectors?: unknown[] } }).results?.detectors ?? []) as {
    check: string;
    description: string;
    elements?: { type: string; name: string; type_specific_fields?: { parent?: { name?: string; type?: string } } }[];
  }[];
  return dets.map((d) => {
    const fnEl = d.elements?.find((e) => e.type === "function");
    const cEl = d.elements?.find((e) => e.type === "contract");
    return {
      check: d.check,
      contract: fnEl?.type_specific_fields?.parent?.name ?? cEl?.name ?? "-",
      fn: fnEl?.name ?? "-",
      description: d.description.trim().split("\n")[0] ?? "",
    };
  });
}

export function unallowed(findings: SlitherFinding[], allow: Set<string>): SlitherFinding[] {
  return findings.filter((f) => !allow.has(`${f.check}|${f.contract}|${f.fn}`));
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, "../.."));
  const out = join(tmpdir(), `slither-${process.pid}.json`);
  const p = Bun.spawnSync(["slither", ".", "--json", out, "--exclude-dependencies", "--filter-paths", "lib/|test/|script/"], { cwd: join(root, "contracts"), stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 && p.exitCode !== 255) {
    console.error(`run-slither: slither exited ${p.exitCode}`);
    process.exit(1);
  }
  const bad = unallowed(parseSlither(JSON.parse(readFileSync(out, "utf8"))), loadAllow(readFileSync(join(import.meta.dir, "slither-allow.txt"), "utf8")));
  if (bad.length) {
    for (const f of bad) console.error(`run-slither: ${f.check} | ${f.contract} | ${f.fn} | ${f.description}`);
    process.exit(1);
  }
  console.log("run-slither: no findings outside ops/ci/slither-allow.txt");
}
