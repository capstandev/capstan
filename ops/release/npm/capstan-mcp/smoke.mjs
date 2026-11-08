// Smoke test for capstan-mcp under plain Node, no network: tarball contents, versions in step with server.json, the
// bridge against a local stub (JSON and event-stream answers, notifications), and every refusal.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fail = (m) => { console.error(`smoke: FAIL ${m}`); process.exit(1); };
if (!existsSync(join(here, "LICENSE"))) copyFileSync(join(here, "..", "..", "..", "..", "LICENSE"), join(here, "LICENSE"));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const srv = JSON.parse(readFileSync(join(here, "server.json"), "utf8"));
if (pkg.mcpName !== srv.name) fail("mcpName != server.json name");
if (pkg.version !== srv.version || pkg.version !== srv.packages[0].version) fail("versions differ between package.json and server.json");
if (!readFileSync(join(here, "capstan-mcp.mjs"), "utf8").includes(`const VERSION = "${pkg.version}"`)) fail("bridge VERSION != package version");
const files = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: here, encoding: "utf8" }))[0].files.map((f) => f.path).sort();
if (JSON.stringify(files) !== JSON.stringify(["LICENSE", "README.md", "capstan-mcp.mjs", "package.json"])) fail(`tarball files ${JSON.stringify(files)}`);

const seen = [];
const stub = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const m = JSON.parse(body); seen.push({ m, auth: req.headers.authorization || "" });
    if (m.id === undefined) { res.writeHead(202); res.end(); return; }
    if (m.method === "tools/list") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "capstan_quote" }] } })}\n\n`); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "capstan" } } }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${stub.address().port}/mcp`;
const bin = join(here, "capstan-mcp.mjs");
const base = { PATH: process.env.PATH, HOME: here };

const run = (env, input) => new Promise((resolve) => {
  const p = spawn(process.execPath, [bin], { env: { ...base, ...env } }); let out = "", err = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => resolve({ code, out, err })); p.stdin.end(input);
});
const msgs = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
].map((m) => JSON.stringify(m)).join("\n") + "\n";
const r = await run({ CAPSTAN_MCP_URL: url, CAPSTAN_API_KEY: "cpst_acct_0123456789abcdef" }, msgs);
const lines = r.out.trim().split("\n").map((l) => JSON.parse(l));
if (r.code !== 0 || lines.length !== 2) fail(`bridge answered ${lines.length} lines, exit ${r.code}: ${r.err}`);
if (lines[0].result?.serverInfo?.name !== "capstan" || lines[1].result?.tools?.[0]?.name !== "capstan_quote") fail("answers not forwarded");
if (seen.length !== 3 || seen[0].auth !== "Bearer cpst_acct_0123456789abcdef") fail("requests or bearer not forwarded");

const k = await run({ CAPSTAN_MCP_URL: url, AGENT_PRIVATE_KEY: "0xdeadbeefcafe" }, "");
if (k.code !== 1 || !k.err.includes("AGENT_PRIVATE_KEY") || (k.err + k.out).includes("deadbeef")) fail("a key setting was not refused cleanly");
const h = await run({ CAPSTAN_MCP_URL: "http://example.com/mcp" }, "");
if (h.code !== 1 || !h.err.includes("must be https")) fail("plain http to a remote host was not refused");
const dead = await run({ CAPSTAN_MCP_URL: "http://127.0.0.1:9/mcp" }, `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`);
if (!dead.out.includes("could not be reached") || dead.err.includes("    at ")) fail("unreachable server not reported plainly");
const v = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
if (v.stdout.trim() !== pkg.version) fail("--version");
stub.close();
console.log(`smoke: PASS (${files.length} files, bridge, refusals, Node ${process.version})`);
