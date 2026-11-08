// Security review r1, review-r1:1 F1: close-all and signer.sign derive the intent from the server's payload, so the
// payload price must still be bounded by an independent reference price (closeAllSlippageBps). A compromised server
// that returns a reduce-only close-all sell at 1% of the mark, or asks signer.sign to sign an opening order, is
// refused and nothing reaches the venue.
import { describe, expect, test } from "bun:test";
import type { UnsignedVenuePayload } from "@capstan/schema";
import { formatPrice, l1Digest, type HlOrderAction } from "@capstan/signer-hl";
import { clientSpreadPorts } from "../src/spreads";
import { sdkClient, startStack } from "./stack";

const redigest = (b: UnsignedVenuePayload): UnsignedVenuePayload => {
  const p = b.payload as { action: HlOrderAction; nonce: number; expiresAfter: number };
  return { ...b, digest: l1Digest(p.action, null, p.nonce, "Mainnet", p.expiresAfter) };
};
// the close-all sell priced at 1% of where the honest build put it
const dumpPrice = (b: UnsignedVenuePayload): UnsignedVenuePayload => {
  const a = (b.payload as { action: HlOrderAction }).action;
  if (a?.type !== "order" || !a.orders[0]!.r) return b;
  a.orders[0]!.p = formatPrice(String(Number(a.orders[0]!.p) / 100), 5, "down");
  return redigest(b);
};

describe("security r1 F1 (sdk)", () => {
  test("close-all-refuses-a-price-far-from-the-reference", async () => {
    const s = await startStack({ tamper: { build: dumpPrice } });
    try {
      const { client } = await sdkClient(s);
      await client.onboard("hyperliquid");
      await client.signAndSubmit(await client.buildOrder({ marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "limit", limitPx: "76000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 }, "hyperliquid", "relay"));
      const n = s.venue.st.exchangePosts.length;
      const res = await client.closeAll(["hyperliquid"]);
      expect(res.length).toBe(1);
      expect(res[0]!.receiptId).toBeNull();
      expect(res[0]!.error).toContain("price");
      expect(s.venue.st.exchangePosts.length).toBe(n);
    } finally {
      s.stop();
    }
  });

  test("signer-sign-bounds-price-and-refuses-opening-orders-without-an-intent", async () => {
    const s = await startStack();
    try {
      const { client } = await sdkClient(s);
      await client.onboard("hyperliquid");
      const agentRef = client.agents()[0]!.agentRef;
      const owner = client.agents()[0]!.owner;
      const build = async (intent: object) => (await (await fetch(`${s.apiBase}/orders/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, agentRef, intent, mode: "relay" }) })).json()) as UnsignedVenuePayload;
      // an opening buy the server asks the host to sign, with no user intent: refused
      const open = await build({ marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "limit", limitPx: "76000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 });
      expect(((await client.signer.sign(open).catch((x) => x)) as { field?: string }).field).toBe("reduceOnly");
      // a reduce-only sell at 1% of the mark: refused on price
      const close = dumpPrice(await build({ marketId: "hyperliquid:-:BTC", side: "sell", size: "0.001", type: "limit", limitPx: "76000", tif: "ioc", reduceOnly: true, maxSlippageBps: 50 }));
      expect(((await client.signer.sign(close).catch((x) => x)) as { field?: string }).field).toBe("price");
    } finally {
      s.stop();
    }
  });

  test("kill-close-all-refuses-a-price-far-from-the-reference", async () => {
    // the kill path signs its reduce-only closes before the key wipe and posts them straight to the venue
    const s = await startStack({ tamper: { build: dumpPrice } });
    try {
      const { client } = await sdkClient(s);
      const d = await client.onboard("hyperliquid");
      const n = s.venue.st.exchangePosts.length;
      const k = await client.kill(d.agentRef, true);
      expect(k.closeAllResults?.length).toBe(1);
      expect(k.closeAllResults![0]!.status).toBe("not_sent");
      expect(k.closeAllResults![0]!.error).toContain("price");
      expect(s.venue.st.exchangePosts.length).toBe(n);
    } finally {
      s.stop();
    }
  });

  test("kill-close-all-at-an-honest-price-goes-out", async () => {
    const s = await startStack();
    try {
      const { client } = await sdkClient(s);
      const d = await client.onboard("hyperliquid");
      const n = s.venue.st.exchangePosts.length;
      const k = await client.kill(d.agentRef, true);
      expect(k.closeAllResults?.[0]?.status).toBe("accepted");
      expect(s.venue.st.exchangePosts.length).toBe(n + 1);
    } finally {
      s.stop();
    }
  });

  test("spread-ports-sign-opening-legs-with-the-checked-intent", async () => {
    // the spread executor signs its opening IOC legs through clientSpreadPorts: they must sign (with the intent
    // buildOrder checked), and a payload the executor did not build is refused
    const s = await startStack();
    try {
      const { client } = await sdkClient(s);
      await client.onboard("hyperliquid");
      const api = { post: async () => ({}) } as never;
      const ports = clientSpreadPorts(client, api, "plan-1", { fillOf: async () => ({ filled: "0", avgPx: null, done: true }) });
      const leg = await ports.build({ marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "limit", limitPx: "76000", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 }, "hyperliquid");
      const env = await ports.sign(leg);
      expect(env.buildId).toBe(leg.buildId);
      const r = await ports.submit(env);
      expect(r.status).toBe("accepted");
      // a payload from elsewhere (not built by this executor) is never signed
      const other = { ...leg, buildId: "01JXXXXXXXXXXXXXXXXXXXXXXX" };
      expect(await Promise.resolve().then(() => ports.sign(other)).then(() => "signed", (e: Error) => e.message)).toContain("built");
    } finally {
      s.stop();
    }
  });
});
