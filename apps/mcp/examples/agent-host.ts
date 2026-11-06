// A minimal MCP host for Capstan: the MCP client SDK plus the Capstan SDK (packages/sdk). It quotes, builds, checks
// the build with the SDK (every field against the intent, the builder against the pin), signs with the local key store,
// submits, reads the receipt and verifies it. The key never leaves this process: the MCP server only ever sees the
// signed envelope.
//   bun apps/mcp/examples/agent-host.ts --local   runs the whole path on a local stack (needs DATABASE_URL)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { checkBuild, hlAssetId, type KeyStore, type Pins, type VenueMarketSpec } from "@capstan/sdk";
import { signEnvelope } from "@capstan/sdk/src/sign";
import type { Hex, OrderIntent, Receipt, SignedEnvelope, UnsignedVenuePayload } from "@capstan/schema";

export interface AgentHostOptions {
  mcpUrl: string;
  fetch?: typeof fetch;
  /** The Capstan API key the MCP server forwards (Authorization: Bearer ...). Not a wallet key. */
  bearer: string;
  owner: Hex;
  agentRef: string;
  agentAddress: Hex;
  keystore: KeyStore;
  keyRef: string;
  /** "Short N of an asset": the canonical asset, the side and the USD notional. */
  want: { canonicalAsset: string; side: "buy" | "sell"; notionalUsd: string; marketId: string; holdHours?: number };
  /** Independent market facts and a reference price (from the venue's own public meta, not from Capstan). */
  market: VenueMarketSpec & { szDecimals?: number };
  refPx: string;
  pins: Pins;
  approvedMaxBps: number;
  nowMs?: number;
  log?: (line: string) => void;
}

export interface AgentRun {
  quote: Record<string, unknown>;
  build: UnsignedVenuePayload;
  submit: { order: Record<string, unknown>; receiptId: string };
  receipt: Receipt;
  verify: { valid: boolean; checks: Record<string, unknown> };
}

const structured = <T>(r: CallToolResult, what: string): T => {
  if (r.isError) throw new Error(`${what} failed: ${(r.content[0] as { text?: string } | undefined)?.text ?? "error"}`);
  return r.structuredContent as T;
};

/** Size in base units for a USD notional at a reference price, floored to the market's size decimals. */
export function sizeFor(notionalUsd: string, refPx: string, szDecimals: number): string {
  const raw = Number(notionalUsd) / Number(refPx);
  const f = 10 ** szDecimals;
  return (Math.floor(raw * f) / f).toFixed(szDecimals);
}

export async function runAgent(o: AgentHostOptions): Promise<AgentRun> {
  const log = o.log ?? (() => {});
  const client = new Client({ name: "capstan-agent-host", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(o.mcpUrl), { ...(o.fetch ? { fetch: o.fetch } : {}), requestInit: { headers: { authorization: `Bearer ${o.bearer}` } } });
  await client.connect(transport);
  try {
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
    // 1 quote every venue that lists the asset
    const quote = structured<Record<string, unknown>>(await call("capstan_quote", { canonicalAsset: o.want.canonicalAsset, side: o.want.side, notionalUsd: o.want.notionalUsd, leverage: 2, holdHours: o.want.holdHours ?? 8, orderType: "market" }), "quote");
    log(`quote: ${(quote.legs as { marketId: string; status: string; refusal?: { reason?: string } }[]).map((l) => `${l.marketId} ${l.status}${l.refusal?.reason ? ` (${l.refusal.reason})` : ""}`).join(", ")}`);
    // 2 build on the chosen market
    const intent: OrderIntent = { marketId: o.want.marketId, side: o.want.side, size: sizeFor(o.want.notionalUsd, o.refPx, o.market.szDecimals ?? 3), type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 };
    const build = structured<UnsignedVenuePayload>(await call("capstan_build_order", { owner: o.owner, agentRef: o.agentRef, intent, mode: "relay" }), "build");
    // 3 check the build locally (never trust the server's digest), then sign with the local key
    const checked = checkBuild(intent, build, { venue: build.venue, approvedMax: o.approvedMaxBps, pins: o.pins, nowMs: o.nowMs ?? Date.now(), network: "mainnet", market: o.market, refPx: o.refPx, identity: { owner: o.owner, agentAddress: o.agentAddress } });
    if (!checked.ok) throw new Error(`the build failed the local check: ${checked.code} ${checked.field}`);
    const env: SignedEnvelope = await signEnvelope(build, { keystore: o.keystore, keyRef: o.keyRef, signerRef: o.agentAddress, digest: checked.digest });
    log(`signed locally: ${env.payloadHash}`);
    // 4 submit the signed envelope only
    const submit = structured<AgentRun["submit"]>(await call("capstan_submit", { buildId: build.buildId, signedEnvelope: env }), "submit");
    // 5 the receipt and its check
    const receipt = structured<Receipt>(await call("capstan_get_receipt", { receiptId: submit.receiptId }), "receipt");
    const verify = structured<AgentRun["verify"]>(await call("capstan_verify_receipt", { receiptId: submit.receiptId }), "verify");
    log(`receipt ${receipt.receiptId}: builder ${receipt.builder ? `${receipt.builder.address} ${receipt.builder.feeBps} bps` : "none"}, valid ${verify.valid}`);
    return { quote, build, submit, receipt, verify };
  } finally {
    await client.close();
  }
}

/** The local run: the e2e stack (fake venues, real API and relay, this database), one HIP-3 short of TSLA. */
async function runLocal(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("agent-host --local needs DATABASE_URL (a local Postgres)");
    return 1;
  }
  const { e2eStack, API_KEY, TSLA } = await import("../test/stack");
  const { memoryKeyStore, mergePins, PINS } = await import("@capstan/sdk");
  const { BUILDER } = await import("../../../packages/adapters/hyperliquid/test/helpers");
  const { T0 } = await import("../../../packages/adapters/hyperliquid/test/orders/util");
  const stack = await e2eStack();
  try {
    const keystore = memoryKeyStore();
    const k = await keystore.create("hyperliquid", "secp256k1");
    const agentAddress = k.publicPart.toLowerCase() as Hex;
    const agentRef = await stack.delegate(agentAddress);
    const run = await runAgent({
      mcpUrl: stack.mcpUrl,
      fetch: stack.mcpFetch,
      bearer: API_KEY,
      owner: stack.owner,
      agentRef,
      agentAddress,
      keystore,
      keyRef: k.ref,
      // "short 2 ETH-equivalent of TSLA": 2 ETH at 2,500 USD is 5,000 USD of TSLA
      want: { canonicalAsset: "EQ:TSLA", side: "sell", notionalUsd: "5000", marketId: TSLA },
      market: { venue: "hyperliquid", marketId: TSLA, assetId: hlAssetId(1, 1), szDecimals: 3 },
      refPx: "347.65",
      pins: mergePins(PINS, { networks: { mainnet: { builders: { hyperliquid: BUILDER, aster: null } } } }),
      approvedMaxBps: 3,
      nowMs: T0,
      log: (l) => console.log(l),
    });
    const ok = run.receipt.builder?.feeBps === 2 && run.verify.valid === true;
    console.log(JSON.stringify({ ok, receiptId: run.receipt.receiptId, builder: run.receipt.builder, onChainRoot: run.verify.checks.onChainRoot }));
    keystore.close?.();
    return ok ? 0 : 1;
  } finally {
    await stack.stop();
  }
}

if (import.meta.main) {
  if (!process.argv.includes("--local")) {
    console.error("usage: bun apps/mcp/examples/agent-host.ts --local");
    process.exit(2);
  }
  process.exit(await runLocal());
}
