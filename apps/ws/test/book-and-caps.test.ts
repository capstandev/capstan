// R19 (todo 29): a book: subscriber gets a snapshot, then deltas with seq, and a fresh snapshot after any gap in the
// upstream sequence (or when it asks); a connection over its tier's wsSubs cap is refused the extra subscription.
// Also the 1 s coalesced markets.ticker built from marks and best bid and ask of every mapped market.
import { afterAll, describe, expect, test } from "bun:test";
import { PUBSUB } from "@capstan/core";
import { LIMITS } from "@capstan/plans";
import type { OrderBook } from "@capstan/schema";
import { addr, client, signedSub, startWs, wsKey } from "./helpers";

const stacks: Awaited<ReturnType<typeof startWs>>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));
const M = "hyperliquid:-:BTC";
const book = (seq: number, bid: string, ask: string): OrderBook => ({ marketId: M, bids: [[bid, "1"], ["99", "2"]], asks: [[ask, "1"], ["102", "2"]], asOf: new Date().toISOString(), seq });

describe("ws book and caps", () => {
  test("seq-gap-and-tier-cap", async () => {
    const s = await startWs({ bookOf: async () => book(10, "100", "101"), marketsForAsset: async (a) => (a === "CR:BTC" ? [M, "aster:-:BTCUSDT"] : []), capOf: async (o) => (o ? LIMITS.pro.wsSubs : LIMITS.free.wsSubs) });
    stacks.push(s);
    const c = await client(s.url);
    c.send({ op: "sub", channel: `book:${M}` });
    const snap = await c.next((m) => m.type === "snapshot");
    expect(snap).toMatchObject({ channel: `book:${M}`, seq: 0 });
    expect((snap.book as OrderBook).bids[0]).toEqual(["100", "1"]);
    // consecutive upstream books: deltas with consecutive seq
    s.bus.publish(PUBSUB.book(M), JSON.stringify(book(11, "100", "101")));
    expect(await c.next((m) => m.type === "delta")).toMatchObject({ seq: 1, bids: [], asks: [] }); // same levels as the snapshot
    s.bus.publish(PUBSUB.book(M), JSON.stringify(book(12, "100.5", "101")));
    const d1 = await c.next((m) => m.type === "delta");
    expect(d1).toMatchObject({ seq: 2, bids: [["100.5", "1"], ["100", "0"]], asks: [] });
    // a gap upstream (13 missing): a fresh snapshot, not a delta
    s.bus.publish(PUBSUB.book(M), JSON.stringify(book(14, "100.6", "101")));
    const g = await c.next((m) => m.type === "snapshot" || m.type === "delta");
    expect(g).toMatchObject({ type: "snapshot", seq: 3, reason: "gap" });
    // a client that missed a message asks for a snapshot
    c.send({ op: "resync", channel: `book:${M}` });
    expect(await c.next((m) => m.type === "snapshot")).toMatchObject({ seq: 3 });

    // ticker: coalesced, carries every mapped venue
    c.send({ op: "sub", channel: "markets.ticker:CR:BTC" });
    await c.next((m) => m.type === "subscribed" && m.channel === "markets.ticker:CR:BTC");
    for (let i = 0; i < 20; i++) s.bus.publish(PUBSUB.mark(M), JSON.stringify({ mark: String(100 + i) }));
    s.bus.publish(PUBSUB.book("aster:-:BTCUSDT"), JSON.stringify({ ...book(1, "99.9", "100.2"), marketId: "aster:-:BTCUSDT" }));
    const t = await c.next((m) => m.type === "ticker");
    expect((t.venues as Record<string, { mark?: string }>)[M]!.mark).toBe("119");
    await Bun.sleep(150);
    expect(c.inbox.filter((m) => m.type === "ticker").length).toBeLessThanOrEqual(1); // one per interval, not one per mark

    // caps: an anonymous connection gets the free cap (50); the 51st subscription is refused
    const anon = await client(s.url);
    for (let i = 0; i < LIMITS.free.wsSubs; i++) anon.send({ op: "sub", channel: `book:m${i}` });
    for (let i = 0; i < LIMITS.free.wsSubs; i++) await anon.next((m) => m.type === "subscribed");
    anon.send({ op: "sub", channel: "book:one-too-many" });
    expect(await anon.next((m) => m.type === "error")).toMatchObject({ code: "VENUE_RATE_LIMITED" });
    // a signed Pro owner on its connection gets the Pro cap (500)
    const sk = wsKey("pro-owner");
    const pro = await client(s.url);
    pro.send(signedSub(sk, `account:${addr(sk)}`, Date.now()));
    await pro.next((m) => m.type === "subscribed");
    for (let i = 0; i < 60; i++) pro.send({ op: "sub", channel: `book:p${i}` });
    for (let i = 0; i < 60; i++) expect((await pro.next((m) => m.type === "subscribed" || m.type === "error")).type).toBe("subscribed");
    expect(LIMITS.pro.wsSubs).toBe(500);
    c.close();
    anon.close();
    pro.close();
  });
});
