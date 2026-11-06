// R10 (todo 29): account:, risk:, plan: and receipts: need an owner-signed subscribe; a wrong signer is refused;
// public channels need none. Events reach only the signed subscriber.
import { afterAll, describe, expect, test } from "bun:test";
import { PUBSUB } from "@capstan/core";
import { addr, client, signedSub, startWs, wsKey } from "./helpers";

const owner = wsKey("owner");
const agent = wsKey("agent");
const stranger = wsKey("stranger");
const stacks: Awaited<ReturnType<typeof startWs>>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));

describe("ws subscribe", () => {
  test("owner-signed", async () => {
    const s = await startWs({ planSigners: async (id) => (id === "plan-1" ? [addr(owner), addr(agent)] : []) });
    stacks.push(s);
    const c = await client(s.url);
    const o = addr(owner);
    const now = Date.now();
    // public channels: no signature
    for (const ch of ["book:hyperliquid:-:BTC", "markets.ticker:CR:BTC", "funding:CR:BTC"]) {
      c.send({ op: "sub", channel: ch });
      expect((await c.next((m) => m.channel === ch && (m.type === "subscribed" || m.type === "error"))).type).toBe("subscribed");
    }
    for (const ch of [`account:${o}`, `risk:${o}`, `receipts:${o}`, "plan:plan-1"]) {
      // unsigned: refused
      c.send({ op: "sub", channel: ch });
      expect(await c.next((m) => m.channel === ch && m.type === "error")).toMatchObject({ code: "UNAUTHORIZED" });
      // signed by a stranger for the owner: refused
      c.send(signedSub(stranger, ch, now, o));
      expect(await c.next((m) => m.channel === ch && m.type === "error")).toMatchObject({ code: "UNAUTHORIZED" });
      // the stranger's own valid signature on the owner's channel: refused
      c.send(signedSub(stranger, ch, now + 1));
      expect(await c.next((m) => m.channel === ch && m.type === "error")).toMatchObject({ code: "UNAUTHORIZED" });
    }
    // the owner's signature: allowed, and events flow
    c.send(signedSub(owner, `receipts:${o}`, now + 2));
    expect((await c.next((m) => m.channel === `receipts:${o}`)).type).toBe("subscribed");
    s.bus.publish(PUBSUB.receipts(o), JSON.stringify({ receiptId: "r-1" }));
    expect(await c.next((m) => m.type === "event")).toMatchObject({ channel: `receipts:${o}`, data: { receiptId: "r-1" } });
    // a replayed subscribe (same ts, so the same nonce) is refused on a new connection
    const c2 = await client(s.url);
    c2.send(signedSub(owner, `receipts:${o}`, now + 2));
    expect(await c2.next((m) => m.type === "error")).toMatchObject({ code: "UNAUTHORIZED" });
    // an old signature (issued more than 5 minutes ago) is refused
    c2.send(signedSub(owner, `account:${o}`, now - 6 * 60_000));
    expect(await c2.next((m) => m.type === "error")).toMatchObject({ code: "UNAUTHORIZED" });
    // a plan: its owner's active agent may sign
    c2.send(signedSub(agent, "plan:plan-1", now + 3, addr(agent)));
    expect((await c2.next((m) => m.channel === "plan:plan-1")).type).toBe("subscribed");
    c.close();
    c2.close();
  });
});
