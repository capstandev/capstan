// R14: onboard HL, build, check, sign, submit in relay mode, receive a receipt and verify it, on a local stack whose
// API runs the real Hyperliquid adapter against a fake venue.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { OrderIntent } from "@capstan/schema";
import { createClient } from "../src/client";
import { memoryKeyStore } from "../src/keys/memory";
import { mergePins, PINS } from "../src/pins";
import { BUILDER_ASTER, BUILDER_HL, T0 } from "./helpers";
import { hlTemplatePin, startStack } from "./stack";
import { testWallet } from "./wallet-fixture";

let stack: Awaited<ReturnType<typeof startStack>>;
beforeAll(async () => {
  stack = await startStack({ port: 22010 });
});
afterAll(() => stack.stop());

describe("end to end", () => {
  test("hl-relay-roundtrip", async () => {
    const pin = await hlTemplatePin(stack.apiBase);
    const wallet = testWallet();
    const ks = memoryKeyStore();
    const client = createClient({
      apiBase: stack.apiBase,
      network: "mainnet",
      keystore: ks,
      walletSigner: wallet,
      pinned: { networks: { mainnet: { ...PINS.networks.mainnet, builders: { hyperliquid: BUILDER_HL, aster: BUILDER_ASTER }, templateHashes: { ...PINS.networks.mainnet.templateHashes, hyperliquid: [pin] }, receiptSigners: [{ address: stack.receiptSigner }] } } },
      venueHosts: { hyperliquid: stack.venue.url },
      now: () => T0,
    });
    const d = await client.onboard("hyperliquid");
    expect(d.agentActive).toBe(true);
    expect(d.builderMaxBps).toBe(3);
    expect(d.agentRef).toMatch(/^hl:0x[0-9a-f]{40}$/);
    // eligibility, approveAgent and approveBuilderFee: three wallet prompts, after the SDK's own plain-words lines
    expect(wallet.prompts).toEqual(["typed:Declaration", "typed:HyperliquidTransaction:ApproveAgent", "typed:HyperliquidTransaction:ApproveBuilderFee"]);
    expect(wallet.shown[0]!.join(" ")).toContain("at most 0.03% (3 bps)");
    const keys = await ks.list();
    expect(keys.length).toBe(1);
    expect(`hl:${keys[0]!.publicPart}`).toBe(d.agentRef);

    const intent: OrderIntent = { marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "limit", limitPx: "76000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 };
    const cb = await client.buildOrder(intent, "hyperliquid", "relay");
    expect(cb.digest).toBe(cb.build.digest);
    const out = await client.signAndSubmit(cb);
    expect(out.order.status).toBe("open");
    expect(out.order.venueOrderId).toBe("1000");
    expect(out.receiptId).toMatch(/^r\d{6}$/);
    const v = await client.verifyReceipt(out.receiptId!);
    expect(v.checks.signature).toBe(true);
    expect(v.checks.leaf).toBe(true);
    expect(v.checks.proof).toBe(true);
    // no anchor pinned: the posted root was not read, so the receipt is not valid (security r1, review-r1:6 F1)
    expect(v).toMatchObject({ valid: false, status: "unchecked" });
    expect(v.checks.onChainRoot).toBe("unchecked");
    // a client with the anchor reader reads the posted root: valid
    const anchored = createClient({ apiBase: stack.apiBase, network: "mainnet", keystore: memoryKeyStore(), walletSigner: testWallet(), pinned: { networks: { mainnet: { ...PINS.networks.mainnet, receiptSigners: [{ address: stack.receiptSigner }] } } }, anchor: stack.anchor, now: () => T0 });
    expect(await anchored.verifyReceipt(out.receiptId!)).toMatchObject({ valid: true, status: "valid", checks: { onChainRoot: true } });
    // the relay forwarded exactly one order to the venue, signed by the local agent key
    const orders = stack.venue.st.exchangePosts.filter((x) => (x as { action: { type: string } }).action.type === "order");
    expect(orders.length).toBe(1);
    // the shipped pins carry the real mainnet builder (wallet pack 2026-11-12), not the test stack's one
    expect(mergePins(PINS).networks.mainnet.builders.hyperliquid).toBe("0x9a76f0230118b43a3ea8ee265f15405adcd7bf92");
    ks.close?.();
  });
});

describe("other client paths on the local stack", () => {
  test("cancel, close-all and the MCP signer all go through the same checks", async () => {
    const { sdkClient } = await import("./stack");
    const s = await startStack();
    try {
      const { client } = await sdkClient(s);
      await client.onboard("hyperliquid");
      const intent: OrderIntent = { marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "limit", limitPx: "76000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 };
      const placed = await client.signAndSubmit(await client.buildOrder(intent, "hyperliquid", "relay"));
      const c = await client.cancel({ marketId: intent.marketId, venueOrderId: placed.order.venueOrderId }, "hyperliquid");
      expect(c.status).toBe("cancelled");
      const closed = await client.closeAll(["hyperliquid"]);
      expect(closed).toEqual([{ venue: "hyperliquid", marketId: "hyperliquid:-:BTC", receiptId: expect.stringMatching(/^r\d+$/) }]);
      const last = s.venue.st.exchangePosts.at(-1) as { action: { type: string; orders: { r: boolean }[] } };
      expect([last.action.type, last.action.orders[0]!.r]).toEqual(["order", true]);

      // an MCP host signs a build it fetched itself: still checked (pins, fee, account, digest)
      const agentRef = client.agents()[0]!.agentRef;
      const owner = client.agents()[0]!.owner;
      const raw = await (await fetch(`${s.apiBase}/orders/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, agentRef, intent, mode: "relay" }) })).json();
      const env = await client.signer.sign(raw, intent);
      expect(env.buildId).toBe(raw.buildId);
      const bad = structuredClone(raw);
      bad.payload.action.builder.b = "0x00000000000000000000000000000000000000aa";
      expect(((await client.signer.sign(bad, intent).catch((x) => x)) as { field: string }).field).toBe("builder.address");
    } finally {
      s.stop();
    }
    // a close-all that would open a position is refused, nothing is sent
    const s2 = await startStack({ closeAllNotReduceOnly: true });
    try {
      const { client } = await sdkClient(s2);
      await client.onboard("hyperliquid");
      await client.signAndSubmit(await client.buildOrder({ marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "limit", limitPx: "76000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 }, "hyperliquid", "relay"));
      const n = s2.venue.st.exchangePosts.length;
      const res = await client.closeAll();
      expect(res[0]!.receiptId).toBeNull();
      expect(res[0]!.error).toContain("reduce-only");
      expect(s2.venue.st.exchangePosts.length).toBe(n);
    } finally {
      s2.stop();
    }
  });
});
