// S13: the MCP agent end to end against the running MCP server, which talks to the running api: the example agent
// host quotes, builds through capstan_build_order, checks and signs locally, submits through capstan_submit, reads
// the receipt (builder fee 2 bps) and verifies it. The agent key was made and onboarded by the SDK; the MCP server
// only ever sees the owner's API key and signed envelopes.
import { accountWallet, capstanMessage, createClient, hlAssetId, memoryKeyStore, mergePins, PINS } from "@capstan/sdk";
import type { Hex } from "@capstan/schema";
import { runAgent } from "../../../apps/mcp/examples/agent-host";
import { API, freshWallet, PORTS, RHC, stateAddr, type Row } from "../lib";
import type { Ctx } from "../every-tx";
import { api, BTC, ensureMarkets, forkPins, userFetch } from "./money";

export async function s13(ctx: Ctx): Promise<Row[]> {
  await ensureMarkets(ctx);
  const wallet = freshWallet();
  const ks = memoryKeyStore();
  const pinned = await forkPins(ctx);
  const client = createClient({ apiBase: API, network: "mainnet", keystore: ks, walletSigner: accountWallet(wallet), pinned, presentSteps: false, venueHosts: { hyperliquid: `http://127.0.0.1:${PORTS.hl}` }, anchor: { rpcUrl: RHC, address: ctx.deployed.anchor }, fetch: userFetch() });
  const ob = await client.onboard("hyperliquid");
  const agent = client.agents().find((a) => a.agentRef === ob.agentRef)!;
  // the owner's API key (the bearer the MCP server forwards): created with the owner's wallet signature
  const owner = wallet.address.toLowerCase() as Hex;
  const issuedAt = Date.now();
  const message = capstanMessage({ purpose: "api_key_create", owner, host: `127.0.0.1:${PORTS.api}`, chainId: 4663, nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex"), issuedAt, expiresAt: issuedAt + 5 * 60_000 });
  const sig = await wallet.signMessage({ message });
  const key = await api<{ key: string }>("POST", "/account/keys", { owner, message, sig });
  if (key.status !== 201) throw new Error(`owner API key: ${key.status} ${JSON.stringify(key.body)}`);
  const run = await runAgent({
    mcpUrl: `http://127.0.0.1:${PORTS.mcp}/mcp`,
    bearer: key.body.key,
    owner,
    agentRef: agent.agentRef,
    agentAddress: agent.publicPart.toLowerCase() as Hex,
    keystore: ks,
    keyRef: agent.keyRef,
    want: { canonicalAsset: "CR:BTC", side: "buy", notionalUsd: "100", marketId: BTC },
    market: { venue: "hyperliquid", marketId: BTC, assetId: hlAssetId(0, 0), szDecimals: 5 },
    refPx: "76154.5",
    pins: mergePins(PINS, pinned),
    approvedMaxBps: 3,
  });
  const legs = run.quote.legs as { marketId: string; status: string }[];
  const fee = run.receipt.builder as { feeBps?: number; address?: string } | undefined;
  return [
    { id: "S13", scenario: "MCP capstan_quote", ref: "tools/call capstan_quote", gas: "-", result: legs.some((l) => l.marketId === BTC && l.status === "ok") ? "pass" : "fail", receipt: "-", check: legs.map((l) => `${l.marketId} ${l.status}`).join(", ") },
    { id: "S13", scenario: "MCP build, local check and sign, capstan_submit", ref: `build ${run.build.buildId}`, gas: "-", result: run.receipt.action === "order.submit" && fee?.feeBps === 2 && fee.address?.toLowerCase() === stateAddr("builder").toLowerCase() ? "pass" : "fail", receipt: run.submit.receiptId, check: `${run.receipt.action}, builder ${fee?.feeBps} bps` },
    { id: "S13", scenario: "MCP capstan_verify_receipt", ref: "tools/call capstan_verify_receipt", gas: "-", result: run.verify.valid === true && run.verify.checks.signature === true && run.verify.checks.proof === true ? "pass" : "fail", receipt: run.submit.receiptId, check: JSON.stringify(run.verify.checks) },
  ];
}
