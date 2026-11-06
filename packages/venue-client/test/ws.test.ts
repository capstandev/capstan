// R12: reconnect after a server close, resubscribe every active subscription exactly once, never exceed maxNewPerMin.
import { afterAll, describe, expect, test } from "bun:test";
import { venueWs } from "../src/ws";

type Conn = { id: number; msgs: string[]; openedAt: number };

function wsServer() {
  const conns: Conn[] = [];
  let next = 0;
  let closeOnOpen = 0;
  const sockets = new Set<Bun.ServerWebSocket<Conn>>();
  const server = Bun.serve<Conn>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const c: Conn = { id: next++, msgs: [], openedAt: Date.now() };
      conns.push(c);
      return srv.upgrade(req, { data: c }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        if (closeOnOpen > 0) {
          closeOnOpen--;
          ws.close();
        }
      },
      message(ws, m) {
        const s = String(m);
        ws.data.msgs.push(s);
        if (s.includes("subscribe")) ws.send(JSON.stringify({ channel: "ok", echo: JSON.parse(s) }));
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    conns,
    closeAll: () => [...sockets].forEach((s) => s.close()),
    setCloseOnOpen: (n: number) => (closeOnOpen = n),
    stop: () => server.stop(true),
  };
}

const srv = wsServer();
afterAll(() => srv.stop());

const waitFor = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timeout");
    await Bun.sleep(10);
  }
};

describe("venueWs", () => {
  test("reconnect-resubscribe", async () => {
    const got: unknown[] = [];
    const ws = venueWs("hyperliquid", srv.url, { maxConns: 2, maxNewPerMin: 3, maxSubs: 10, pingMs: 0, newConnWindowMs: 1500, backoffBaseMs: 20, backoffMaxMs: 40 });
    const a = { method: "subscribe", subscription: { type: "l2Book", coin: "BTC" } };
    const b = { method: "subscribe", subscription: { type: "l2Book", coin: "ETH" } };
    ws.subscribe(a, (m) => got.push(m));
    const unB = ws.subscribe(b, () => {});
    await waitFor(() => srv.conns.length === 1 && srv.conns[0]!.msgs.length === 2);
    await waitFor(() => got.length >= 1);
    expect(srv.conns[0]!.msgs.map((m) => JSON.parse(m))).toEqual([a, b]);

    // the server drops the connection and refuses the next 4 attempts at once
    srv.setCloseOnOpen(4);
    srv.closeAll();
    await waitFor(() => ws.stats().connections === 1 && srv.conns.length === 6, 10_000);
    const last = srv.conns[srv.conns.length - 1]!;
    await waitFor(() => last.msgs.length === 2);
    await Bun.sleep(50);
    // each active subscription sent exactly once on the new connection
    expect(last.msgs.map((m) => JSON.parse(m))).toEqual([a, b]);
    // never more than 3 new connections inside any 1.5 s window (the client's own open times)
    const opens = ws.stats().openedAt;
    expect(opens.length).toBe(6);
    for (const t of opens) expect(opens.filter((x) => x >= t && x < t + 1500).length).toBeLessThanOrEqual(3);
    expect(opens[5]! - opens[0]!).toBeGreaterThanOrEqual(1500); // 6 opens at 3 per window needed a second window

    // after an unsubscribe, a reconnect only sends what is still active
    unB();
    srv.closeAll();
    await waitFor(() => srv.conns.length === 7 && srv.conns[6]!.msgs.length === 1, 10_000);
    await Bun.sleep(50);
    expect(srv.conns[6]!.msgs.map((m) => JSON.parse(m))).toEqual([a]);
    ws.close();
  }, 20_000);

  test("subscriptions spread over connections up to maxConns", async () => {
    const ws = venueWs("hyperliquid", srv.url, { maxConns: 2, maxNewPerMin: 30, maxSubs: 2, pingMs: 0 });
    for (let i = 0; i < 4; i++) ws.subscribe({ method: "subscribe", n: i }, () => {});
    expect(() => ws.subscribe({ method: "subscribe", n: 5 }, () => {})).toThrow("every connection is full");
    await waitFor(() => ws.stats().connections === 2);
    expect(ws.stats().subscriptions).toBe(4);
    ws.close();
  });
});
