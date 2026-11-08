// Bundle the SDK into one Node ESM file for the capstan-sdk npm package (dependencies inlined, no install step).
// Identifiers stay readable so the published file can be audited. The build refuses Bun-only imports and any
// absolute build-machine path, so the same file runs under plain Node.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const root = join(here, "..", "..", "..", "..");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { name: string; version: string };
const commit = Bun.spawnSync(["git", "rev-parse", "--short=12", "HEAD"], { cwd: root }).stdout.toString().trim() || "unknown";
const out = join(here, "dist");
mkdirSync(out, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "packages", "sdk", "src", "index.ts")],
  target: "node",
  format: "esm",
  minify: { whitespace: true, syntax: true, identifiers: false },
  banner: `// ${pkg.name} ${pkg.version}, built from commit ${commit}. MIT.`,
});
if (!result.success) {
  for (const l of result.logs) console.error(l);
  process.exit(1);
}
const art = result.outputs[0];
if (!art) throw new Error("build produced no output");
const code = await art.text();
const problems: string[] = [];
if (/from\s*["']bun["']|require\(["']bun["']\)|import\(["']bun["']\)/.test(code)) problems.push("imports a bun module");
if (/(^|[^.\w$])Bun\./m.test(code)) problems.push("reads the bare Bun global");
if (/\/Users\/[^/"'\s]+\/|\/home\/[^/"'\s]+\/(?!runner\/)/.test(code)) problems.push("carries a build-machine path");
if (problems.length) {
  console.error(`build: refused: ${problems.join(", ")}`);
  process.exit(1);
}
writeFileSync(join(out, "capstan-sdk.js"), code);
copyFileSync(join(root, "LICENSE"), join(here, "LICENSE"));
// The Lighter signer loads its pinned WASM from ../artifacts/ and its worker from ./ relative to the bundle.
const wasmDir = join(root, "packages", "signers", "lighter-wasm");
mkdirSync(join(here, "artifacts"), { recursive: true });
for (const f of ["lighter-signer.wasm", "wasm_exec.js", "SHA256SUMS"]) copyFileSync(join(wasmDir, "artifacts", f), join(here, "artifacts", f));
copyFileSync(join(wasmDir, "src", "worker.mjs"), join(out, "worker.mjs"));
console.log(`build: dist/capstan-sdk.js ${(code.length / 1024).toFixed(0)} KB (${pkg.name} ${pkg.version}, ${commit})`);
