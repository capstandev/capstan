// Records a few public WebSocket messages per config (order_book and market_stats for market 0, read-only stream) for
// the ingest tests. Keyless, read-only (?readonly=true), about 4 s per config, closes its own socket.
//   bun packages/adapters/lighter/test/fixtures/capture-ws.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const MAX_LEVELS = 20;

function trimBook(m: Record<string, unknown>): Record<string, unknown> {
  const ob = m.order_book as { asks?: unknown[]; bids?: unknown[] } | undefined;
  if (!ob) return m;
  return { ...m, order_book: { ...ob, asks: (ob.asks ?? []).slice(0, MAX_LEVELS), bids: (ob.bids ?? []).slice(0, MAX_LEVELS) } };
}

async function capture(venue: string, url: string, ms: number): Promise<void> {
  const messages: unknown[] = [];
  const ws = new WebSocket(`${url}?readonly=true`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      resolve();
    }, ms);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", channel: "order_book/0" }));
      ws.send(JSON.stringify({ type: "subscribe", channel: "market_stats/0" }));
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
      const books = messages.filter((x) => String((x as { type?: string }).type).endsWith("order_book")).length;
      const stats = messages.filter((x) => String((x as { type?: string }).type).endsWith("market_stats")).length;
      const t = String(m.type ?? "");
      if (t.endsWith("order_book") && books >= 6) return;
      if (t.endsWith("market_stats") && stats >= 2) return;
      messages.push(trimBook(m));
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error("ws error"));
    };
  });
  const record = { name: `${venue}/ws_market0`, capturedAt: new Date().toISOString(), source: "live", venue, request: { url: `${url}?readonly=true`, subscribe: ["order_book/0", "market_stats/0"] }, messages, note: `books trimmed to ${MAX_LEVELS} levels per side` };
  writeFileSync(join(DIR, venue, "ws_market0.json"), JSON.stringify(record, null, 1) + "\n");
}

if (import.meta.main) {
  await capture("lighter-304", "wss://mainnet.zklighter.elliot.ai/stream", 4000);
  await capture("lighter-466324", "wss://api.rh.lighter.xyz/stream", 4000);
  console.log("ws fixtures written");
}
