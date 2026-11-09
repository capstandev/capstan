// capstan-mcp from its npm tarball over stdio (ops/mcp-proof/run.sh): the official MCP SDK client starts
// `npx --no capstan-mcp` (the installed bin, never a registry fetch), lists the tools and calls capstan_markets through
// the bridge to the local hosted-mode endpoint at CAPSTAN_MCP_URL.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import { scanAll } from "./keyscan.mjs";

const fail = (m) => { console.error(`stdio-list: FAIL ${m}`); process.exit(1); };
const env = { PATH: process.env.PATH, HOME: process.env.HOME, CAPSTAN_MCP_URL: process.env.CAPSTAN_MCP_URL, npm_config_cache: process.env.npm_config_cache ?? "", npm_config_update_notifier: "false" };
const transport = new StdioClientTransport({ command: "npx", args: ["--no", "capstan-mcp"], env, stderr: "pipe" });
let stderr = "";
transport.stderr?.on("data", (d) => (stderr += d));
const client = new Client({ name: "capstan-stdio-proof", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
if (names.length !== 17) fail(`listed ${names.length} tools: ${names.join(",")} ${stderr}`);
const m = await client.callTool({ name: "capstan_markets", arguments: { venue: "hyperliquid" } });
if (m.isError || !m.content?.[0]?.text?.includes("hyperliquid:-:BTC")) fail(`capstan_markets over stdio: ${JSON.stringify(m).slice(0, 300)}`);
const found = [...scanAll(JSON.stringify(tools), "tools"), ...scanAll(JSON.stringify(m), "markets")];
if (found.length) fail(found.join("; "));
await client.close();
writeFileSync(process.env.OUT_JSON ?? "stdio-list.json", JSON.stringify({ tools: names }, null, 2));
console.log(`stdio-list: PASS npx capstan-mcp listed ${names.length} tools and answered capstan_markets over stdio`);
