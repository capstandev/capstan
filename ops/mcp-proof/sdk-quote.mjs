// capstan-sdk from its npm tarball under plain Node (ops/mcp-proof/run.sh): build a client with an in-memory key store
// (no key is made or held for a quote) and ask the local api for a route quote. Writes the quote to OUT_JSON.
import { createClient, memoryKeyStore, PINS } from "capstan-sdk";
import { writeFileSync } from "node:fs";
import { scanAll } from "./keyscan.mjs";

const apiBase = process.env.API_BASE;
if (!apiBase) throw new Error("API_BASE is required");
const fail = (m) => { console.error(`sdk-quote: FAIL ${m}`); process.exit(1); };
if (typeof process.versions.bun === "string") fail("running under Bun; this proof is for plain Node");
const client = createClient({ apiBase, network: "testnet", keystore: memoryKeyStore(), venueHosts: { hyperliquid: process.env.HL_URL } });
const q = await client.quote({ marketIds: ["hyperliquid:-:BTC"], side: "buy", sizeBase: "0.01", leverage: 2, holdHours: 1, orderType: "market" });
const legs = q.legs ?? [];
const leg = legs.find((l) => l.marketId === "hyperliquid:-:BTC");
if (!leg) fail(`no BTC leg in ${JSON.stringify(q).slice(0, 300)}`);
if (leg.status !== "ok") fail(`BTC leg status ${leg.status}`);
const found = scanAll(JSON.stringify(q), "quote");
if (found.length) fail(found.join("; "));
writeFileSync(process.env.OUT_JSON ?? "sdk-quote.json", JSON.stringify(q, null, 2));
console.log(`sdk-quote: PASS quote ${q.requestId ?? q.quoteId ?? "-"} BTC leg ${leg.status} avgFillPx ${leg.avgFillPx} sizeBase ${leg.sizeBase} (${legs.length} legs, Node ${process.version}, sdk pins ${Object.keys(PINS.networks ?? {}).join("/")})`);
