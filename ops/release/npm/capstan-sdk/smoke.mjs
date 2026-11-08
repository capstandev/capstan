// Smoke test for the capstan-sdk package under plain Node, no network: the tarball holds exactly the bundle, README,
// LICENSE and package.json; the bundle imports in an empty folder; the public entry points exist; nothing in it
// looks like a key or a build-machine path.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fail = (m) => { console.error(`smoke: FAIL ${m}`); process.exit(1); };
const pack = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: here, encoding: "utf8" }));
const files = pack[0].files.map((f) => f.path).sort();
const want = ["LICENSE", "README.md", "artifacts/SHA256SUMS", "artifacts/lighter-signer.wasm", "artifacts/wasm_exec.js", "dist/capstan-sdk.js", "dist/worker.mjs", "package.json"];
if (JSON.stringify(files) !== JSON.stringify(want)) fail(`tarball files ${JSON.stringify(files)} != ${JSON.stringify(want)}`);

const dir = mkdtempSync(join(tmpdir(), "capstan-sdk-smoke-"));
cpSync(join(here, "dist"), join(dir, "node_modules", "capstan-sdk", "dist"), { recursive: true });
cpSync(join(here, "package.json"), join(dir, "node_modules", "capstan-sdk", "package.json"));
writeFileSync(join(dir, "probe.mjs"), `import * as s from "capstan-sdk"; console.log(JSON.stringify(Object.keys(s).sort()));`);
const keys = JSON.parse(execFileSync(process.execPath, ["probe.mjs"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } }));
for (const k of ["createClient", "checkBuild", "checkOnboardingBundle", "verifyReceiptOffline", "memoryKeyStore", "fileKeyStore", "PINS", "SdkError"]) {
  if (!keys.includes(k)) fail(`export ${k} missing`);
}
const code = readFileSync(join(here, "dist", "capstan-sdk.js"), "utf8");
const wasm = readFileSync(join(here, "artifacts", "lighter-signer.wasm"));
const sha = (await import("node:crypto")).createHash("sha256").update(wasm).digest("hex");
if (!code.includes(sha)) fail("shipped lighter-signer.wasm does not match the sha256 pinned in the bundle");
if (/\/Users\/[^/"'\s]+\//.test(code)) fail("bundle carries a /Users/ path");
if (/(PRIVATE_KEY|MNEMONIC)\s*[:=]\s*["'][^"']{20,}/.test(code)) fail("bundle holds a key-like value");
console.log(`smoke: PASS (${files.length} files, ${keys.length} exports, Node ${process.version})`);
