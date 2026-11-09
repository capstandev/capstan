#!/usr/bin/env node
// capstan-mcp: a stdio bridge to the hosted Capstan MCP server, for MCP clients that only speak stdio.
// It holds no key and asks for none: every tool is the hosted server's, and every write tool returns an UNSIGNED
// payload that your own wallet or the capstan-sdk signs. It forwards each JSON-RPC message from stdin to
// CAPSTAN_MCP_URL (default https://api.get-capstan.com/mcp) and writes each answer to stdout, one per line.
// Settings: CAPSTAN_MCP_URL (https only, or http on 127.0.0.1 for testing), CAPSTAN_API_KEY (optional bearer).
import { createInterface } from "node:readline";

const VERSION = "0.1.0";
const KEYLIKE = /(PRIVATE_KEY|MNEMONIC|SEED_PHRASE|SECRET_KEY)$/i;
const die = (msg) => { process.stderr.write(`capstan-mcp: ${msg}\n`); process.exit(1); };

if (process.argv.includes("--version")) { process.stdout.write(`${VERSION}\n`); process.exit(0); }
for (const k of Object.keys(process.env)) if (KEYLIKE.test(k)) die(`refusing to start: ${k} is set. capstan-mcp never takes a key; unset it.`);
let url;
try { url = new URL(process.env.CAPSTAN_MCP_URL || "https://api.get-capstan.com/mcp"); } catch { die("CAPSTAN_MCP_URL is not a URL"); }
const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) die("CAPSTAN_MCP_URL must be https (http only on 127.0.0.1)");
const apiKey = process.env.CAPSTAN_API_KEY || "";
if (apiKey && !/^cpst_[A-Za-z0-9_-]{10,200}$/.test(apiKey)) die("CAPSTAN_API_KEY does not look like a Capstan API key (cpst_...)");

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": `capstan-mcp/${VERSION}` };
if (apiKey) headers.authorization = `Bearer ${apiKey}`;
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const errorFor = (id, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message } });

async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); return; }
  const id = Array.isArray(msg) ? null : msg.id;
  let res;
  try { res = await fetch(url, { method: "POST", headers, body: line, signal: AbortSignal.timeout(30000) }); }
  catch { if (id !== undefined) out(errorFor(id, "the Capstan MCP server could not be reached")); return; }
  if (res.status === 202 || res.status === 204) return;
  const text = await res.text();
  const type = res.headers.get("content-type") || "";
  const bodies = type.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean)
    : [text];
  let wrote = false;
  for (const b of bodies) { try { out(JSON.parse(b)); wrote = true; } catch { /* not JSON: reported below */ } }
  if (!wrote && id !== undefined) out(errorFor(id, `the Capstan MCP server answered HTTP ${res.status}`));
}

let chain = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim()) chain = chain.then(() => forward(line));
}).on("close", () => { chain.then(() => process.exit(0)); });
