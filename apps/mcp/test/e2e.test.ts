// R3, R4 (todo 32, spec D3): the agent end to end on the local stack. The example host quotes a "short 2 ETH-equivalent
// of TSLA" intent on Hyperliquid xyz:TSLA and a Lighter-RH TSLA market, builds on xyz:TSLA, checks and signs locally with
// a memory key store, submits through capstan_submit, gets a receipt whose builder fee is 2 bps, and
// capstan_verify_receipt answers valid with onChainRoot 'not_posted', then true after the hour's root is posted to a
// CapstanReceiptAnchor on anvil by the todo 28 anchor job. A spy on every inbound MCP request finds no key material.
// Needs DATABASE_URL and ANVIL_URL (skips without them).
import { afterAll, describe, expect, test } from "bun:test";
import { hourEpochOf } from "@capstan/receipts";
import { hlAssetId, memoryKeyStore, mergePins, PINS } from "@capstan/sdk";
import type { Hex } from "@capstan/schema";
import { anchorHour } from "../../workers/src/anchor";
import { ANCHOR_ABI } from "../../workers/src/anchor/abi";
import { fixture, type Fixture } from "../../workers/test/anchor/fixture";
import { BUILDER } from "../../../packages/adapters/hyperliquid/test/helpers";
import { T0 } from "../../../packages/adapters/hyperliquid/test/orders/util";
import { runAgent, type AgentRun } from "../examples/agent-host";
import { API_KEY, e2eStack, RH_TSLA, TSLA } from "./stack";

const PG = process.env.DATABASE_URL;
const ANVIL = process.env.ANVIL_URL;
const d = PG && ANVIL ? describe : describe.skip;
const KEY_FIELD = new RegExp(["priv" + "ate", "sec" + "ret", "se" + "ed", "mne" + "monic", "pass" + "phrase"].join("|"), "i");

function keysOf(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) x.forEach((v) => keysOf(v, out));
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x as object)) (out.push(k), keysOf(v, out));
  return out;
}

d("agent end to end", () => {
  let f: Fixture;
  let stack: Awaited<ReturnType<typeof e2eStack>>;
  let run: AgentRun;
  const generated: Uint8Array[] = [];
  afterAll(async () => {
    await stack?.stop();
    await f?.drop();
  });

  test("quote-build-sign-submit-receipt", async () => {
    f = await fixture("mcp-e2e");
    const readRoot = async (hour: number) => ((await f.rpc.readContract({ address: f.anchor, abi: ANCHOR_ABI, functionName: "rootOf", args: [BigInt(hour)] })) as readonly [Hex, number, bigint])[0];
    stack = await e2eStack({ db: f.db, readRoot });
    // the key store's randomness is recorded, so the spy below knows the exact key bytes it must never see
    const keystore = memoryKeyStore({ random: (n) => { const b = crypto.getRandomValues(new Uint8Array(n)); generated.push(b.slice()); return b; } });
    const k = await keystore.create("hyperliquid", "secp256k1");
    const agentAddress = k.publicPart.toLowerCase() as Hex;
    const agentRef = await stack.delegate(agentAddress);
    run = await runAgent({
      mcpUrl: stack.mcpUrl,
      fetch: stack.mcpFetch,
      bearer: API_KEY,
      owner: stack.owner,
      agentRef,
      agentAddress,
      keystore,
      keyRef: k.ref,
      want: { canonicalAsset: "EQ:TSLA", side: "sell", notionalUsd: "5000", marketId: TSLA },
      market: { venue: "hyperliquid", marketId: TSLA, assetId: hlAssetId(1, 1), szDecimals: 3 },
      refPx: "347.65",
      pins: mergePins(PINS, { networks: { mainnet: { builders: { hyperliquid: BUILDER, aster: null } } } }),
      approvedMaxBps: 3,
      nowMs: T0,
    });
    // the quote covered both venues that list TSLA
    const legs = run.quote.legs as { marketId: string; status: string }[];
    expect(legs.map((l) => l.marketId).sort()).toEqual([TSLA, RH_TSLA].sort());
    expect(legs.every((l) => l.status === "ok")).toBe(true);
    // the build was for the short, the relay sent it once, the receipt carries the 2 bps builder fee
    expect(run.build.preview).toMatchObject({ marketId: TSLA, side: "sell", builderFeeBps: 2 });
    expect(stack.relay.venues.hl.length).toBe(1);
    expect(run.receipt.action).toBe("order.submit");
    expect(run.receipt.builder).toMatchObject({ address: BUILDER, feeBps: 2, rawUnit: "f=20" });
    expect(run.receipt.owner).toBe(stack.owner);
    expect(run.receipt.signedPayloadHash).toBeDefined();
    // verified now: signature, leaf and proof hold; the root is not on chain yet
    expect(run.verify.valid).toBe(true);
    expect(run.verify.checks.onChainRoot).toBe("not_posted");
    // the anchor job posts the hour's root on anvil; the same tool now sees it on chain
    const hour = hourEpochOf(run.receipt.ts);
    const posted = await anchorHour(hour, f.deps());
    expect(posted.status).toBe("posted");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "verify-again", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(stack.mcpUrl), { fetch: stack.mcpFetch }));
    const again = (await client.callTool({ name: "capstan_verify_receipt", arguments: { receiptId: run.receipt.receiptId } })) as unknown as { structuredContent: { valid: boolean; checks: { onChainRoot: unknown } } };
    await client.close();
    expect(again.structuredContent.valid).toBe(true);
    expect(again.structuredContent.checks.onChainRoot).toBe(true);
    keystore.close?.();
  }, 120_000);

  test("no-key-on-server", () => {
    expect(run).toBeDefined();
    expect(stack.inbound.length).toBeGreaterThanOrEqual(6);
    expect(generated.length).toBeGreaterThan(0);
    const secrets = generated.filter((b) => b.length >= 16).map((b) => Buffer.from(b).toString("hex"));
    expect(secrets.length).toBeGreaterThan(0);
    for (const body of stack.inbound) {
      const lower = body.toLowerCase();
      for (const s of secrets) {
        expect(lower.includes(s)).toBe(false);
        expect(body.includes(Buffer.from(s, "hex").toString("base64"))).toBe(false);
      }
      if (body) expect(keysOf(JSON.parse(body)).filter((k) => KEY_FIELD.test(k))).toEqual([]);
    }
    // and the API behind the MCP server got no key either
    for (const c of stack.apiCalls) for (const s of secrets) expect(c.body.toLowerCase().includes(s)).toBe(false);
  });
});
