// R8, R15, R16: direct mode posts from this host and claims a receipt; a policy forces relay; Aster reads follow the
// agent's onboarding mode; amend sends the new order only after the cancel succeeded.
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentPolicy, OrderIntent } from "@capstan/schema";
import { digestTrade, recoverDigestSigner } from "@capstan/signer-aster";
import { SdkError } from "../src/errors";
import { OWNER, T0 } from "./helpers";
import { sdkClient, startStack } from "./stack";

const stacks: Awaited<ReturnType<typeof startStack>>[] = [];
afterEach(() => {
  while (stacks.length) stacks.pop()!.stop();
});
const stack = async (o: Parameters<typeof startStack>[0] = {}) => {
  const s = await startStack(o);
  stacks.push(s);
  return s;
};
const BUY: OrderIntent = { marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "limit", limitPx: "76000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 };
const orderPosts = (s: Awaited<ReturnType<typeof startStack>>) => s.venue.st.exchangePosts.filter((x) => (x as { action: { type: string } }).action.type === "order");
const apiHits = (s: Awaited<ReturnType<typeof startStack>>, p: string) => s.hits.filter((h) => h.path === `/v1${p}`);

const policy = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({ owner: OWNER, agents: [], maxNotionalPerOrderUsd: "500", maxGrossNotionalUsd: "1000", maxLeverage: 5, allowedMarkets: "*", allowedVenues: ["hyperliquid"], maxOrdersPerDay: 10, expiresAt: new Date(T0 + 86_400_000).toISOString(), nonce: "pol-1", ...over });

describe("modes", () => {
  test("direct-and-policy", async () => {
    // direct: the SDK host posts to the venue itself, then claims a receipt with the venue's answer
    const s = await stack();
    const { client } = await sdkClient(s);
    await client.onboard("hyperliquid");
    const r = await client.signAndSubmit(await client.buildOrder(BUY, "hyperliquid", "direct"));
    expect(apiHits(s, "/orders/submit").length).toBe(0);
    const claims = apiHits(s, "/receipts/claim");
    expect(claims.length).toBe(1);
    expect((claims[0]!.body as { venueResponse: { status: string } }).venueResponse.status).toBe("ok");
    expect(orderPosts(s).length).toBe(1);
    expect(r.order.venueOrderId).toBe("1000");
    const rec = await s.receipts.get(r.receiptId!);
    expect(rec?.action).toBe("order.claim");

    // agent-safe policy: a direct request is forced to relay, and the local policy refuses a breach before signing
    const s2 = await stack();
    const p = policy();
    const { client: c2 } = await sdkClient(s2, { policy: p });
    const d = await c2.onboard("hyperliquid", { policy: p });
    // the SDK added the new agent to the policy the owner signed
    expect(c2.agents()[0]!.policy!.agents).toEqual([{ venue: "hyperliquid", agentRef: d.agentRef }]);
    const cb = await c2.buildOrder(BUY, "hyperliquid", "direct");
    expect(cb.mode).toBe("relay");
    expect((apiHits(s2, "/orders/build")[0]!.body as { mode: string }).mode).toBe("relay");
    await c2.signAndSubmit(cb);
    expect(apiHits(s2, "/orders/submit").length).toBe(1);
    expect(apiHits(s2, "/receipts/claim").length).toBe(0);
    const big = (await c2.buildOrder({ ...BUY, size: "0.01" }, "hyperliquid", "relay").catch((x) => x)) as SdkError;
    expect([big.code, big.field]).toEqual(["POLICY_BREACH", "maxNotionalPerOrderUsd"]);
    expect(apiHits(s2, "/orders/submit").length).toBe(1);
  });

  test("aster-read-path", async () => {
    const s = await stack();
    const { client } = await sdkClient(s);
    const relayAgent = await client.onboard("aster", { mode: "relay" });
    const r1 = await client.asterRead("positionRisk", relayAgent.agentRef);
    expect(r1).toEqual({ ok: true, mode: "relay" });
    // relay: the SDK signs the read and posts only the signed query; this host never calls Aster
    expect(s.aster.hits).toEqual([]);
    const in1 = s.ingests[0] as { mode: string; snapshot?: unknown; signedRead: { query: string; signature: `0x${string}`; signer: string; path: string } };
    expect(in1.mode).toBe("relay");
    expect(in1.snapshot).toBeUndefined();
    expect(in1.signedRead.path).toBe("/fapi/v3/positionRisk");
    expect(recoverDigestSigner(digestTrade(in1.signedRead.query, 1666), in1.signedRead.signature)?.toLowerCase()).toBe(in1.signedRead.signer.toLowerCase());
    // relay-whitelisted Aster agents cannot trade from this host
    const e = (await client.buildOrder({ ...BUY, marketId: "aster:-:BTCUSDT" }, "aster", "direct").catch((x) => x)) as SdkError;
    expect([e.code, e.field]).toEqual(["INVALID_INPUT", "mode"]);

    const directAgent = await client.onboard("aster", { mode: "direct", directIp: "198.51.100.9" });
    const r2 = await client.asterRead("positionRisk", directAgent.agentRef);
    expect(r2.mode).toBe("direct");
    expect(s.aster.hits).toEqual(["GET /fapi/v3/positionRisk"]);
    const in2 = s.ingests[1] as { mode: string; snapshot: unknown[] };
    expect(in2.mode).toBe("direct");
    expect(Array.isArray(in2.snapshot)).toBe(true);
    // the direct-mode bundle whitelisted the user's own IP, the relay-mode one the relay egress IP
    const builds = apiHits(s, "/onboarding/build").map((h) => h.body as { mode: string; venue: string }).filter((b) => b.venue === "aster");
    expect(builds.map((b) => b.mode)).toEqual(["relay", "direct"]);
  });

  test("amend-cancel-first", async () => {
    const s = await stack();
    const { client } = await sdkClient(s);
    await client.onboard("hyperliquid");
    const first = await client.signAndSubmit(await client.buildOrder(BUY, "hyperliquid", "relay"));
    const before = s.hits.length;
    const out = await client.amend(first.order.venueOrderId, { ...BUY, limitPx: "75900" }, "hyperliquid");
    expect(out.order.status).toBe("open");
    // both builds were made and checked before anything was signed; the cancel went first
    const seq = s.hits.slice(before).map((h) => h.path.replace("/v1", ""));
    expect(seq).toEqual(["/orders/cancel/build", "/orders/build", "/orders/submit", "/orders/submit"]);
    const types = s.venue.st.exchangePosts.slice(-2).map((x) => (x as { action: { type: string } }).action.type);
    expect(types).toEqual(["cancel", "order"]);

    // the cancel fails at the venue: the new order is never sent
    s.venue.failCancels = true;
    const n = orderPosts(s).length;
    const e = (await client.amend(out.order.venueOrderId, { ...BUY, limitPx: "75800" }, "hyperliquid").catch((x) => x)) as SdkError;
    expect(e.code).toBe("VENUE_ERROR");
    expect(orderPosts(s).length).toBe(n);

    // a tampered cancel build is refused before anything is signed or sent
    s.venue.failCancels = false;
    const s2 = await stack({ tamper: { build: (b) => ((b.payload as { action: { type: string; cancels?: { o: number }[] } }).action.type === "cancel" ? (((b.payload as { action: { cancels: { o: number }[] } }).action.cancels[0]!.o = 1), b) : b) } });
    const { client: c2 } = await sdkClient(s2);
    await c2.onboard("hyperliquid");
    const f = await c2.signAndSubmit(await c2.buildOrder(BUY, "hyperliquid", "relay"));
    const e2 = (await c2.amend(f.order.venueOrderId, { ...BUY, limitPx: "75900" }, "hyperliquid").catch((x) => x)) as SdkError;
    expect([e2.code, e2.field]).toEqual(["PAYLOAD_MISMATCH", "venueOrderId"]);
    expect(apiHits(s2, "/orders/submit").length).toBe(1);
  });
});
