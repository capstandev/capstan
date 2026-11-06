// R10: kill signs the kill message, calls the endpoint, and wipes the local key even if the server is unreachable.
import { describe, expect, test } from "bun:test";
import { capstanMessage as coreMessage, recoverPersonalSigner } from "@capstan/core";
import type { Hex, OrderIntent } from "@capstan/schema";
import { SdkError } from "../src/errors";
import { capstanMessage } from "../src/signed-message";
import { labelAddr, T0 } from "./helpers";
import { sdkClient, startStack } from "./stack";

const BUY: OrderIntent = { marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "limit", limitPx: "76000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 };

describe("kill", () => {
  test("wipe-always", async () => {
    // reachable: signed with the agent key (self-halt), endpoint called, key wiped, agent gone
    const s = await startStack();
    try {
      const { client, ks } = await sdkClient(s);
      const d = await client.onboard("hyperliquid");
      const agent = d.agentRef.slice(3) as Hex;
      const r = await client.kill(d.agentRef);
      expect(r).toMatchObject({ agentRef: d.agentRef, relayBlocked: true, serverReached: true, keyWiped: true });
      expect(r.revocation?.steps.map((x) => x.kind)).toContain("revoke_agent");
      const body = s.kills[0]!.body as { sig: Hex; message: string; ts: number };
      expect(recoverPersonalSigner(body.message, body.sig)?.toLowerCase()).toBe(agent);
      expect(body.message.split("\n")[0]).toBe("Capstan kill");
      expect(body.ts).toBe(T0);
      expect(await ks.list()).toEqual([]);
      expect(((await client.buildOrder(BUY, "hyperliquid", "relay").catch((x) => x)) as SdkError).code).toBe("KEY_NOT_FOUND");
    } finally {
      s.stop();
    }

    // unreachable: the call fails, the key is still wiped
    const s2 = await startStack();
    const { client: c2, ks: ks2 } = await sdkClient(s2);
    const d2 = await c2.onboard("hyperliquid");
    s2.stop();
    const r2 = await c2.kill(d2.agentRef);
    expect(r2.serverReached).toBe(false);
    expect(r2.relayBlocked).toBe(false);
    expect(r2.error).toBeTruthy();
    expect(await ks2.list()).toEqual([]);

  });

  test("close-all on kill is checked, signed before the wipe and sent to the venue directly", async () => {
    const s = await startStack();
    try {
      const { client, ks } = await sdkClient(s);
      const d = await client.onboard("hyperliquid");
      const r = await client.kill(d.agentRef, true);
      expect(r.closeAllResults).toEqual([{ marketId: "hyperliquid:-:BTC", status: "accepted", receiptId: expect.stringMatching(/^r\d+$/) }]);
      const posted = s.venue.st.exchangePosts.filter((x) => (x as { action: { type: string } }).action.type === "order") as { action: { orders: { r: boolean }[] } }[];
      expect(posted.map((x) => x.action.orders[0]!.r)).toEqual([true]);
      expect(s.hits.some((h) => h.path === "/v1/orders/submit")).toBe(false);
      expect(await ks.list()).toEqual([]);
    } finally {
      s.stop();
    }
  });

  test("the kill message is the server's format, byte for byte", () => {
    const f = { purpose: "kill" as const, owner: labelAddr("owner") as Hex, host: "127.0.0.1:22010", chainId: 4663, nonce: "abcdefgh12345678", issuedAt: T0, expiresAt: T0 + 300_000, body: "hl:0xabc" };
    expect(capstanMessage(f)).toBe(coreMessage(f));
  });
});
