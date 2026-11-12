// The tests gated on ANVIL_URL skip in a plain `bun test`, so a broken one can hide (the MCP e2e receipt check did,
// from 2026-11-08 to 2026-11-12). This runs every such file against a local anvil (chain 31337 only) and fails if any
// test in them fails or is skipped. It uses ANVIL_URL when set, else starts its own anvil on a free local port and
// stops only that process. Needs DATABASE_URL (a migrated local Postgres). Without DATABASE_URL or anvil it fails in
// CI (CI=true) and prints a loud SKIPPED line locally. Never points at a real network.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const CI = process.env.CI === "true";
const GATE = /process\.env\.ANVIL_URL|import \{[^}]*\bANVIL(_URL)?\b[^}]*\} from "\.\/(fixture|anvil)"/;

function gatedFiles(): string[] {
  const ls = spawnSync("git", ["ls-files", "*.test.ts"], { cwd: ROOT, encoding: "utf8" });
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
  return ls.stdout.split("\n").filter((f) => f && !f.startsWith("web/") && GATE.test(readFileSync(join(ROOT, f), "utf8"))).sort();
}

function skipOrFail(why: string): never {
  if (CI) {
    console.error(`check:anvil FAILED: ${why}`);
    process.exit(1);
  }
  console.log(`check:anvil SKIPPED: ${why} (the anvil-gated tests did not run)`);
  process.exit(0);
}

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

async function chainId(url: string): Promise<number | null> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return Number.parseInt(((await r.json()) as { result: string }).result, 16);
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const files = gatedFiles();
  if (files.length === 0) {
    console.error("check:anvil FAILED: no ANVIL_URL-gated test files found (the gate pattern is stale)");
    return 1;
  }
  if (!process.env.DATABASE_URL) skipOrFail("DATABASE_URL is not set");
  let url = process.env.ANVIL_URL;
  let child: ReturnType<typeof spawn> | null = null;
  if (!url) {
    const bin = existsSync(join(homedir(), ".foundry/bin/anvil")) ? join(homedir(), ".foundry/bin/anvil") : "anvil";
    if (spawnSync(bin, ["--version"]).status !== 0) skipOrFail("anvil is not installed");
    const port = await freePort();
    child = spawn(bin, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
    url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100 && (await chainId(url)) === null; i++) await Bun.sleep(100);
  }
  try {
    const id = await chainId(url);
    if (id !== 31337) {
      console.error(`check:anvil FAILED: ${url} answers chain id ${id}, not 31337`);
      return 1;
    }
    console.log(`check:anvil: ${files.length} files on ${url}: ${files.join(" ")}`);
    const r = spawnSync("bun", ["test", "--timeout", "120000", ...files.map((f) => `./${f}`)], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ANVIL_URL: url } });
    const out = `${r.stdout}${r.stderr}`;
    const n = (k: string) => Number(out.match(new RegExp(`^\\s*(\\d+) ${k}$`, "m"))?.[1] ?? "0");
    const [pass, fail, skip] = [n("pass"), n("fail"), n("skip")];
    if (r.status !== 0 || fail > 0 || skip > 0 || pass === 0) {
      console.error(out.split("\n").filter((l) => /\(fail\)|\(skip\)|error:|Expected|Received/.test(l)).slice(0, 60).join("\n"));
      console.error(`check:anvil FAILED: ${pass} pass, ${fail} fail, ${skip} skip (exit ${r.status})`);
      return 1;
    }
    console.log(`check:anvil: ${pass} pass, 0 fail, 0 skip`);
    return 0;
  } finally {
    child?.kill("SIGTERM");
  }
}

process.exit(await main());
