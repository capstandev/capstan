// Outside MCP client for the hosted-mode proof (ops/mcp-proof/run.sh). Runs under plain Node from a temp folder outside
// the repo, with the official MCP SDK client from npm over Streamable HTTP. It holds no key and sends no API key.
// Checks: 17 tools listed; every tool answers a tools/call (a result, never a protocol error); the paid tools answer
// "payments unavailable" (never served free); Host and Origin rules; per-IP rate limits; no key-like value in any
// response body or header. Writes every answer to OUT_JSON and exits 1 on any failed check.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { request } from "node:http";
import { writeFileSync } from "node:fs";
import { scanAll, scanText } from "./keyscan.mjs";

const URL_MCP = process.env.MCP_URL;
const URL_RL = process.env.MCP_RL_URL;
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? "api.capstan.test";
if (!URL_MCP || !URL_RL) throw new Error("MCP_URL and MCP_RL_URL are required");

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`); };
const raw = []; // every HTTP answer the client saw: status, headers, body
const teeFetch = async (u, init) => {
  const res = await fetch(u, init);
  const text = await res.clone().text();
  raw.push({ url: String(u), status: res.status, headers: Object.fromEntries(res.headers), body: text });
  return res;
};

// 1. the official client: initialize, tools/list, then every tool
const client = new Client({ name: "capstan-outside-proof", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_MCP), { fetch: teeFetch }));
const info = client.getServerVersion();
check("initialize", info?.name, `server ${info?.name} ${info?.version}, protocol over Streamable HTTP`);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check("tools/list", names.length === 17, `${names.length} tools: ${names.join(", ")}`);

const OWNER = "0x00000000000000000000000000000000000000a1";
const AGENT = "0x00000000000000000000000000000000000000b2";
const BTC = "hyperliquid:-:BTC";
const SIG = `0x${"11".repeat(65)}`;
const READ = { message: Buffer.from("not-a-real-signed-read").toString("base64"), signature: SIG };
const ULID = "01JB0000000000000000000000";
const INTENT = { marketId: BTC, side: "buy", size: "0.01", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 };
const ENV = { buildId: ULID, venue: "hyperliquid", encoding: "hl_l1_action", signedBody: {}, signature: "0x00", signerRef: "x", payloadHash: "0x00" };
const calls = [
  ["capstan_markets", { venue: "hyperliquid" }],
  ["capstan_funding", { asset: "CR:BTC" }],
  ["capstan_quote", { marketIds: [BTC], side: "buy", sizeBase: "0.01", leverage: 2, holdHours: 1, orderType: "market" }],
  ["capstan_onboarding_build", { venue: "hyperliquid", owner: OWNER, agentAddress: AGENT, builderMaxBps: 3 }],
  ["capstan_build_order", { owner: OWNER, agentRef: "hl:proof", intent: INTENT, mode: "relay" }],
  ["capstan_submit", { buildId: ULID, signedEnvelope: ENV }],
  ["capstan_cancel_build", { owner: OWNER, agentRef: "hl:proof", venueOrderId: "1" }],
  ["capstan_positions", { owner: OWNER, ownerRead: READ }],
  ["capstan_risk", { owner: OWNER, ownerRead: READ }],
  ["capstan_spread_scan", { asset: "CR:BTC" }],
  ["capstan_spread_plan", { owner: OWNER, equivalenceId: "eq-btc", sizeBase: "0.01", leverage: 2, hedgeFailurePolicy: "flatten_leg_a" }],
  ["capstan_plan_status", { planId: ULID }],
  ["capstan_set_policy", { policy: { owner: OWNER, maxNotionalUsd: "100" }, ownerSig: SIG }],
  ["capstan_kill", { agentRef: "hl:proof", sig: SIG, message: "kill hl:proof" }],
  ["capstan_get_receipt", { receiptId: ULID }],
  ["capstan_verify_receipt", { receiptId: ULID }],
  ["capstan_eligibility", { venue: "hyperliquid" }],
];
const answers = {};
const full = {};
const codeOf = (r) => r?.structuredContent?.error?.code ?? (() => { try { return JSON.parse(r.content?.[0]?.text ?? "{}").error?.code; } catch { return undefined; } })();
for (const [name, args] of calls) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const answered = Array.isArray(r.content) && r.content.length > 0;
    full[name] = r.content?.[0]?.text ?? "";
    answers[name] = { isError: !!r.isError, code: codeOf(r) ?? null, text: r.content?.[0]?.text?.slice(0, 600) ?? "" };
    check(`tools/call ${name}`, answered, r.isError ? `tool error ${answers[name].code}` : `data ${answers[name].text.slice(0, 90).replace(/\s+/g, " ")}`);
  } catch (e) {
    answers[name] = { protocolError: String(e?.message ?? e) };
    check(`tools/call ${name}`, false, `protocol error ${String(e?.message ?? e).slice(0, 160)}`);
  }
}
// the paid call on capstan_risk (addresses) and capstan_spread_scan are never served free with payments off
const paid = await client.callTool({ name: "capstan_risk", arguments: { addresses: [{ venue: "hyperliquid", owner: OWNER }] } });
answers["capstan_risk (addresses, paid)"] = { isError: !!paid.isError, code: codeOf(paid) ?? null };
check("paid capstan_risk with X402 off", paid.isError && codeOf(paid) === "X402_PAYMENTS_UNAVAILABLE", `answers ${codeOf(paid)}`);
check("paid capstan_spread_scan with X402 off", answers.capstan_spread_scan.code === "X402_PAYMENTS_UNAVAILABLE", `answers ${answers.capstan_spread_scan.code}`);
check("capstan_markets returns the seeded market", full.capstan_markets.includes(BTC), "hyperliquid:-:BTC listed");
check("capstan_quote returns a leg", !answers.capstan_quote.isError && answers.capstan_quote.text.includes(BTC), answers.capstan_quote.text.slice(0, 120));
await client.close();

// 1b. the same client with a free anonymous Capstan API key (POST /v1/account/keys, owner null: an account key, not a
// wallet key), the way an agent gets one: the build tools answer with unsigned payloads; the key never comes back.
const keyRes = await fetch(`${process.env.API_BASE}/account/keys`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.20" }, body: JSON.stringify({ owner: null }) });
const apiKey = (await keyRes.json()).key;
check("anonymous API key from the api", typeof apiKey === "string" && apiKey.startsWith("cpst_"), `HTTP ${keyRes.status}`);
process.env.PROOF_CANARIES = [process.env.PROOF_CANARIES, apiKey].filter(Boolean).join(",");
const keyed = new Client({ name: "capstan-outside-proof-keyed", version: "1.0.0" });
await keyed.connect(new StreamableHTTPClientTransport(new URL(URL_MCP), { fetch: teeFetch, requestInit: { headers: { authorization: `Bearer ${apiKey}`, "x-forwarded-for": "192.0.2.21" } } }));
const keyedAnswers = {};
for (const [name, args] of calls.filter(([n]) => answers[n]?.code === "UNAUTHORIZED")) {
  const r = await keyed.callTool({ name, arguments: args });
  keyedAnswers[name] = { isError: !!r.isError, code: codeOf(r) ?? null, text: r.content?.[0]?.text?.slice(0, 600) ?? "" };
  full[`keyed ${name}`] = r.content?.[0]?.text ?? "";
  // build_order and submit need the owner's wallet signature on top of any key: that refusal is the right answer
  const ownerSigRefusal = codeOf(r) === "UNAUTHORIZED" && full[`keyed ${name}`].includes("owner signature");
  check(`keyed tools/call ${name}`, Array.isArray(r.content) && r.content.length > 0 && (codeOf(r) !== "UNAUTHORIZED" || ownerSigRefusal), r.isError ? `tool error ${keyedAnswers[name].code}` : `data ${keyedAnswers[name].text.slice(0, 90).replace(/\s+/g, " ")}`);
}
const ob = full["keyed capstan_onboarding_build"] ?? "";
check("keyed capstan_onboarding_build returns an unsigned bundle", !keyedAnswers.capstan_onboarding_build?.isError && ob.includes("hyperliquid") && !/"signature"\s*:\s*"0x[0-9a-f]{130}"/i.test(ob), ob.slice(0, 120).replace(/\s+/g, " "));
await keyed.close();

// 1c. the api's failed-auth guard behind MCP: a client IP whose calls failed auth 10 times in a minute is refused
const bad = new Client({ name: "capstan-outside-proof-badkey", version: "1.0.0" });
await bad.connect(new StreamableHTTPClientTransport(new URL(URL_MCP), { fetch: teeFetch, requestInit: { headers: { authorization: "Bearer cpst_not_a_real_key_000000", "x-forwarded-for": "192.0.2.31" } } }));
const badCodes = [];
for (let i = 0; i < 11; i++) badCodes.push(codeOf(await bad.callTool({ name: "capstan_positions", arguments: { owner: OWNER, ownerRead: READ } })));
await bad.close();
check("api refuses an IP after 10 failed auths (through MCP)", badCodes.slice(0, 10).every((c) => c === "UNAUTHORIZED") && badCodes[10] === "VENUE_RATE_LIMITED", badCodes.join(","));

// 2. Host and Origin rules (raw HTTP, the way a browser page or a rebinding attacker would arrive)
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const post = (url, headers) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(body), ...headers } }, (res) => {
    let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => { raw.push({ url, status: res.statusCode, headers: res.headers, body: text }); resolve({ status: res.statusCode, headers: res.headers, text }); });
  });
  req.on("error", reject); req.end(body);
});
const hostPort = new URL(URL_MCP).host;
check("Host evil.example refused", (await post(URL_MCP, { host: "evil.example" })).status === 403, "403");
check(`Host ${PUBLIC_HOST} (the public api host) accepted`, (await post(URL_MCP, { host: PUBLIC_HOST })).status === 200, "200");
check("Host 127.0.0.1 port accepted", (await post(URL_MCP, { host: hostPort })).status === 200, "200");
const evil = await post(URL_MCP, { origin: "https://evil.example" });
check("browser Origin https://evil.example refused", evil.status === 403, `${evil.status}`);
const noOrigin = await post(URL_MCP, {});
check("no Origin (an agent, not a browser) accepted", noOrigin.status === 200, `${noOrigin.status}`);
const cors = await post(URL_MCP, { origin: `http://${hostPort}` });
check("any answer carries no CORS allow header", !evil.headers["access-control-allow-origin"] && !cors.headers["access-control-allow-origin"], "none");

// 3. rate limits (second MCP entry, MCP_RATE_LIMIT_PER_MIN=5, per IP bucket from X-Forwarded-For as Caddy sets it)
const statuses = [];
for (let i = 0; i < 6; i++) statuses.push((await post(URL_RL, { "x-forwarded-for": "192.0.2.10" })).status);
const sixth = raw.at(-1);
check("6th message in a minute from one IP is refused", statuses.slice(0, 5).every((s) => s === 200) && statuses[5] === 429, `${statuses.join(",")}`);
check("refusal carries Retry-After", Number(sixth.headers["retry-after"]) > 0, `Retry-After ${sixth.headers["retry-after"]}`);
check("another IP keeps its own bucket", (await post(URL_RL, { "x-forwarded-for": "192.0.2.11" })).status === 200, "200");
const batch = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/list" })));
const b = await new Promise((resolve) => {
  const u = new URL(URL_RL);
  const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(batch), "x-forwarded-for": "192.0.2.12" } }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { raw.push({ url: URL_RL, status: res.statusCode, headers: res.headers, body: t }); resolve(res.statusCode); }); });
  req.end(batch);
});
check("a batch of 6 counts as 6 messages", b === 429, `${b}`);

// 4. no key-like value in any answer (bodies and headers)
const findings = [];
for (const r of raw) { findings.push(...scanAll(r.body, `${r.status} ${r.url}`)); findings.push(...scanText(JSON.stringify(r.headers), `headers ${r.url}`)); }
check("no key-like value in any response", findings.length === 0, findings.length ? findings.slice(0, 5).join("; ") : `${raw.length} responses scanned`);

writeFileSync(process.env.OUT_JSON ?? "outside-client.json", JSON.stringify({ server: info, tools: names, answers, keyedAnswers, checks, responses: raw.length }, null, 2));
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `outside-client: FAIL ${failed.length} of ${checks.length}` : `outside-client: ${checks.length} checks pass (17 tools answered over Streamable HTTP)`);
process.exit(failed.length ? 1 : 0);
