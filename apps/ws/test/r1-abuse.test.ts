// Security review r1 review-r1:3 F6: the WebSocket gateway had no per-IP connection cap and no message rate limit,
// and any id after book:, funding: or markets.ticker: created a Redis subscription or a catalog query. After the fix
// an IP holds at most WS_MAX_CONNS_PER_IP sockets, a connection that floods messages is closed, unknown market and
// asset ids are refused without a subscription, and a resync needs the book subscription. Real gateway on a memory bus.
import { afterAll, describe, expect, test } from "bun:test";
import { memoryNonceStore } from "@capstan/core";
import { memoryBus } from "../src/bus";
import { createWsGateway } from "../src/server";
import { client } from "./helpers";

const HOST = "api.capstan.test";
const M = "hyperliquid:-:BTC";
const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

/** The gateway as production builds it, with a counting bus: every bus.sub is a Redis SUBSCRIBE in production. */
async function gateway() {
  const bus = memoryBus();
  let subs = 0;
  let catalogReads = 0;
  const counting = { ...bus, sub: (ch: string, fn: (p: string) => void) => (subs++, bus.sub(ch, fn)) };
  const deps = {
    bus: counting,
    host: HOST,
    nonces: memoryNonceStore(),
    marketsForAsset: async (a: string) => (catalogReads++, a === "CR:BTC" ? [M] : []),
    bookOf: async () => null,
    capOf: async () => 50,
    knownMarket: async (id: string) => id === M,
    knownAsset: async (a: string) => a === "CR:BTC",
    ipOf: () => "203.0.113.7",
    tickerMs: 50,
  };
  const gw = createWsGateway(deps as never);
  const server = await gw.start(0);
  stops.push(() => (gw.stop(), server.stop(true)));
  return { url: `ws://127.0.0.1:${server.port}/v1`, count: () => ({ subs, catalogReads }) };
}

const opens = (url: string) =>
  new Promise<boolean>((resolve) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
    stops.push(() => ws.close());
  });

describe("r1 F6: ws abuse limits", () => {
  test("an 11th connection from one IP is refused", async () => {
    const g = await gateway();
    const results: boolean[] = [];
    for (let i = 0; i < 11; i++) results.push(await opens(g.url));
    expect(results.slice(0, 10).every(Boolean)).toBe(true);
    expect(results[10]).toBe(false);
  });

  test("unknown market and asset ids are refused without a subscription or a catalog query", async () => {
    const g = await gateway();
    const c = await client(g.url);
    stops.push(() => c.close());
    for (const ch of ["book:random-1", "funding:NOPE", "markets.ticker:NOPE"]) {
      c.send({ op: "sub", channel: ch });
      expect(await c.next((m) => m.channel === ch)).toMatchObject({ type: "error", code: "NOT_FOUND" });
    }
    expect(g.count()).toEqual({ subs: 0, catalogReads: 0 });
    // a resync of a book the connection does not hold does nothing
    c.send({ op: "resync", channel: "book:random-2" });
    expect(await c.next((m) => m.channel === "book:random-2")).toMatchObject({ type: "error" });
    c.send({ op: "sub", channel: `book:${M}` });
    expect(await c.next((m) => m.type === "subscribed")).toMatchObject({ channel: `book:${M}` });
  });

  test("a connection that floods messages is closed", async () => {
    const g = await gateway();
    const c = await client(g.url);
    const closed = new Promise<number>((r) => (c.ws.onclose = (e) => r(e.code)));
    for (let i = 0; i < 500; i++) c.send({ op: "unsub", channel: `book:x${i}` });
    const code = await Promise.race([closed, Bun.sleep(3000).then(() => -1)]);
    expect(code).toBe(1008);
  });
});
