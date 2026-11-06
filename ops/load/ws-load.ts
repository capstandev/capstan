// WebSocket load run (spec 15 D1): 5,000 local subscribers on book: and markets.ticker: channels against the gateway
// on an in-memory bus; marks and books are published for a few seconds and every subscriber measures the delivery
// delay of the 1 s coalesced ticker (receive time minus the server's send stamp). Writes ops/load/last-run.json.
// Usage: bun ops/load/ws-load.ts [subscribers=5000] [seconds=6]
import { memoryNonceStore, PUBSUB } from "../../packages/core/src/index";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryBus } from "../../apps/ws/src/bus";
import { createWsGateway } from "../../apps/ws/src/server";

export interface LoadResult {
  subscribers: number;
  connected: number;
  seconds: number;
  tickersReceived: number;
  booksReceived: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  at: string;
}

const pct = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : Number.NaN);

export async function runWsLoad(n = 5000, seconds = 6): Promise<LoadResult> {
  const bus = memoryBus();
  const markets = ["hyperliquid:-:BTC", "lighter-mainnet:-:BTC", "aster:-:BTCUSDT"];
  const gw = createWsGateway({ bus, host: "load.local", nonces: memoryNonceStore(), marketsForAsset: async () => markets, bookOf: async (id) => ({ marketId: id, bids: [["100", "1"]], asks: [["101", "1"]], asOf: new Date().toISOString(), seq: 0 }), capOf: async () => 50, tickerMs: 1000 });
  const server = await gw.start(0);
  const url = `ws://127.0.0.1:${server.port}/v1`;
  const delays: number[] = [];
  let books = 0;
  const sockets: WebSocket[] = [];
  let connected = 0;
  const open = (k: number, tries = 0): Promise<void> =>
    new Promise<void>((resolve) => {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        connected++;
        sockets.push(ws);
        ws.send(JSON.stringify({ op: "sub", channel: "markets.ticker:CR:BTC" }));
        ws.send(JSON.stringify({ op: "sub", channel: `book:${markets[k % markets.length]}` }));
        resolve();
      };
      // the local accept queue can overflow while thousands of sockets open at once: back off and try again
      ws.onerror = () => void (tries < 8 ? Bun.sleep(50 * (tries + 1)).then(() => open(k, tries + 1)).then(resolve) : resolve());
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { type: string; ts?: number };
        if (m.type === "ticker" && typeof m.ts === "number") delays.push(Date.now() - m.ts);
        else if (m.type === "delta" || m.type === "snapshot") books++;
      };
    });
  for (let i = 0; i < n; i += 100) {
    await Promise.all(Array.from({ length: Math.min(100, n - i) }, (_, j) => open(i + j)));
  }
  await Bun.sleep(500);
  const end = Date.now() + seconds * 1000;
  let seq = 1;
  while (Date.now() < end) {
    for (const id of markets) {
      bus.publish(PUBSUB.mark(id), JSON.stringify({ mark: (100 + Math.random()).toFixed(2) }));
      bus.publish(PUBSUB.book(id), JSON.stringify({ marketId: id, bids: [[(100 + Math.random()).toFixed(2), "1"]], asks: [["101", "1"]], asOf: new Date().toISOString(), seq: seq }));
    }
    seq++;
    await Bun.sleep(100);
  }
  await Bun.sleep(1500);
  for (const s of sockets) s.close();
  gw.stop();
  server.stop(true);
  delays.sort((a, b) => a - b);
  const r: LoadResult = { subscribers: n, connected, seconds, tickersReceived: delays.length, booksReceived: books, p50Ms: pct(delays, 50), p99Ms: pct(delays, 99), maxMs: delays.at(-1) ?? Number.NaN, at: new Date().toISOString() };
  mkdirSync(join(import.meta.dir), { recursive: true });
  writeFileSync(join(import.meta.dir, "last-run.json"), `${JSON.stringify(r, null, 2)}\n`);
  return r;
}

if (import.meta.main) {
  const r = await runWsLoad(Number(process.argv[2] ?? 5000), Number(process.argv[3] ?? 6));
  console.log(JSON.stringify(r));
}
