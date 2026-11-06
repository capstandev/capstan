// WebSocket gateway (spec 13.2). Subscribe with { op: 'sub', channel, owner?, ts?, sig? }; unsubscribe with
// { op: 'unsub', channel }; ask for a fresh book with { op: 'resync', channel }.
// - markets.ticker:{asset}: built here from PUBSUB.mark and the best bid and ask of PUBSUB.book for every market mapped to
//   that canonical asset, coalesced to one message per second (only when something changed).
// - book:{marketId}: a snapshot on subscribe, then deltas with a per-market seq; a fresh snapshot after any upstream gap.
// - funding:{asset}: forwarded as published.
// - account:{owner}, risk:{owner}, receipts:{owner}, plan:{planId}: owner-signed subscribe (SIG-1). The signature is the
//   01 capstanMessage with purpose ws_subscribe, body = channel, nonce `ws-<ts>`, issued at ts, valid 5 minutes, signed
//   by the owner (plan: the plan's owner or one of its active agents). A wrong signer is refused.
// The number of subscriptions per connection is capped by the caller's tier (LIMITS.wsSubs, todo 34).
import { SERVICE_METRICS } from "@capstan/telemetry";
import { capstanMessage, PUBSUB, verifyCapstanMessage, type NonceStore } from "@capstan/core";
import type { Hex, OrderBook } from "@capstan/schema";
import type { Server, ServerWebSocket } from "bun";
import type { Bus } from "./bus";

export const PRIVATE_PREFIXES = ["account:", "risk:", "plan:", "receipts:"] as const;
export const PUBLIC_PREFIXES = ["markets.ticker:", "book:", "funding:"] as const;
export const SUB_VALIDITY_MS = 5 * 60_000;
export const BOOK_LEVELS = 20;

export interface WsDeps {
  bus: Bus;
  host: string;
  nonces: NonceStore;
  /** Market ids mapped to a canonical asset (catalog). */
  marketsForAsset(asset: string): Promise<string[]>;
  /** The latest cached book (snapshot on subscribe). */
  bookOf(marketId: string): Promise<OrderBook | null>;
  /** The owner of a spread plan and that owner's active agent addresses. */
  planSigners?(planId: string): Promise<Hex[]>;
  /** Subscriptions allowed per connection for a signed owner (or null for an anonymous connection). */
  capOf(owner: Hex | null): Promise<number>;
  now?: () => number;
  tickerMs?: number;
}

interface ConnState {
  subs: Map<string, () => void>;
  owner: Hex | null;
  cap: number;
  bookSeq: Map<string, number>;
}

export const wsSubscribeMessage = (owner: Hex, channel: string, ts: number, host: string) =>
  capstanMessage({ purpose: "ws_subscribe", owner, host, chainId: 4663, nonce: `ws-${ts}`, issuedAt: ts, expiresAt: ts + SUB_VALIDITY_MS, body: channel });

type Level = [string, string];
function diff(prev: Level[], next: Level[]): Level[] {
  const a = new Map(prev);
  const b = new Map(next);
  const out: Level[] = [];
  for (const [px, sz] of b) if (a.get(px) !== sz) out.push([px, sz]);
  for (const px of a.keys()) if (!b.has(px)) out.push([px, "0"]);
  return out;
}

export function createWsGateway(deps: WsDeps) {
  const now = deps.now ?? Date.now;
  const tickerMs = deps.tickerMs ?? 1000;
  // per-asset ticker state, fed by mark and book channels of every market mapped to the asset
  const tickers = new Map<string, { sockets: Set<ServerWebSocket<ConnState>>; legs: Map<string, { mark?: string; bid?: string; ask?: string }>; dirty: boolean; offs: (() => void)[] }>();
  // per-market book state: last book (top levels), upstream seq and our own seq
  const books = new Map<string, { sockets: Set<ServerWebSocket<ConnState>>; last: OrderBook | null; seq: number; upstream: number | null; off: () => void }>();

  const send = (ws: ServerWebSocket<ConnState>, m: unknown) => ws.send(JSON.stringify(m));
  const err = (ws: ServerWebSocket<ConnState>, channel: string | null, code: string, message: string) => send(ws, { type: "error", channel, code, message });

  const timer = setInterval(() => {
    for (const [asset, t] of tickers) {
      if (!t.dirty || !t.sockets.size) continue;
      t.dirty = false;
      const msg = JSON.stringify({ type: "ticker", channel: `markets.ticker:${asset}`, ts: now(), venues: Object.fromEntries([...t.legs].sort(([a], [b]) => a.localeCompare(b))) });
      for (const ws of t.sockets) ws.send(msg);
    }
  }, tickerMs);

  const top = (b: OrderBook): OrderBook => ({ ...b, bids: b.bids.slice(0, BOOK_LEVELS), asks: b.asks.slice(0, BOOK_LEVELS) });

  async function snapshot(ws: ServerWebSocket<ConnState>, marketId: string) {
    const st = books.get(marketId);
    const b = st?.last ?? (await deps.bookOf(marketId));
    if (st && !st.last && b) st.last = top(b);
    const seq = st?.seq ?? 0;
    ws.data.bookSeq.set(marketId, seq);
    send(ws, { type: "snapshot", channel: `book:${marketId}`, seq, book: b ? top(b) : null });
  }

  function onBook(marketId: string, payload: string) {
    const st = books.get(marketId);
    if (!st) return;
    let b: OrderBook;
    try {
      b = top(JSON.parse(payload) as OrderBook);
    } catch {
      return;
    }
    const gap = st.upstream !== null && typeof b.seq === "number" && b.seq !== st.upstream + 1;
    const prev = st.last;
    st.last = b;
    st.upstream = typeof b.seq === "number" ? b.seq : st.upstream;
    st.seq++;
    for (const ws of st.sockets) {
      if (gap || !prev) {
        ws.data.bookSeq.set(marketId, st.seq);
        send(ws, { type: "snapshot", channel: `book:${marketId}`, seq: st.seq, book: b, reason: gap ? "gap" : "first" });
      } else {
        ws.data.bookSeq.set(marketId, st.seq);
        send(ws, { type: "delta", channel: `book:${marketId}`, seq: st.seq, bids: diff(prev.bids, b.bids), asks: diff(prev.asks, b.asks) });
      }
    }
  }

  async function addTicker(ws: ServerWebSocket<ConnState>, asset: string): Promise<() => void> {
    let t = tickers.get(asset);
    if (!t) {
      const st = { sockets: new Set<ServerWebSocket<ConnState>>(), legs: new Map<string, { mark?: string; bid?: string; ask?: string }>(), dirty: false, offs: [] as (() => void)[] };
      tickers.set(asset, st);
      t = st;
      for (const id of await deps.marketsForAsset(asset)) {
        st.offs.push(
          deps.bus.sub(PUBSUB.mark(id), (p) => {
            try {
              const m = JSON.parse(p) as { mark?: string };
              st.legs.set(id, { ...st.legs.get(id), mark: String(m.mark ?? p) });
            } catch {
              st.legs.set(id, { ...st.legs.get(id), mark: p });
            }
            st.dirty = true;
          }),
          deps.bus.sub(PUBSUB.book(id), (p) => {
            try {
              const b = JSON.parse(p) as OrderBook;
              st.legs.set(id, { ...st.legs.get(id), bid: b.bids[0]?.[0], ask: b.asks[0]?.[0] });
              st.dirty = true;
            } catch {
              /* not a book */
            }
          }),
        );
      }
    }
    t.sockets.add(ws);
    return () => {
      t!.sockets.delete(ws);
      if (!t!.sockets.size) {
        t!.offs.forEach((f) => f());
        tickers.delete(asset);
      }
    };
  }

  function addBook(ws: ServerWebSocket<ConnState>, marketId: string): () => void {
    let st = books.get(marketId);
    if (!st) {
      const s = { sockets: new Set<ServerWebSocket<ConnState>>(), last: null as OrderBook | null, seq: 0, upstream: null as number | null, off: () => {} };
      s.off = deps.bus.sub(PUBSUB.book(marketId), (p) => onBook(marketId, p));
      books.set(marketId, s);
      st = s;
    }
    st.sockets.add(ws);
    return () => {
      st!.sockets.delete(ws);
      if (!st!.sockets.size) {
        st!.off();
        books.delete(marketId);
      }
    };
  }

  function forward(ws: ServerWebSocket<ConnState>, channel: string, busChannel: string): () => void {
    return deps.bus.sub(busChannel, (p) => {
      let data: unknown = p;
      try {
        data = JSON.parse(p);
      } catch {
        /* text */
      }
      send(ws, { type: "event", channel, data });
    });
  }

  async function authorise(channel: string, m: { owner?: unknown; ts?: unknown; sig?: unknown }): Promise<{ ok: true; owner: Hex } | { ok: false; why: string }> {
    const [prefix, id = ""] = [channel.slice(0, channel.indexOf(":") + 1), channel.slice(channel.indexOf(":") + 1)];
    if (typeof m.owner !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(m.owner) || typeof m.ts !== "number" || typeof m.sig !== "string") return { ok: false, why: "an owner-signed subscribe is required" };
    const owner = m.owner.toLowerCase() as Hex;
    let signers: Hex[] = [owner];
    if (prefix === "plan:") {
      const allowed = deps.planSigners ? await deps.planSigners(id) : [];
      if (!allowed.map((a) => a.toLowerCase()).includes(owner)) return { ok: false, why: "not this plan's owner" };
      signers = allowed;
    } else if (id.toLowerCase() !== owner) return { ok: false, why: "the channel belongs to another owner" };
    const text = wsSubscribeMessage(owner, channel, m.ts, deps.host);
    const r = await verifyCapstanMessage(text, m.sig as Hex, { purpose: "ws_subscribe", signers, host: deps.host, nowMs: now(), body: channel }, deps.nonces);
    return r.ok ? { ok: true, owner } : { ok: false, why: r.reason };
  }

  async function onMessage(ws: ServerWebSocket<ConnState>, raw: string | Buffer) {
    let m: { op?: unknown; channel?: unknown; owner?: unknown; ts?: unknown; sig?: unknown };
    try {
      m = JSON.parse(String(raw));
    } catch {
      return err(ws, null, "INVALID_INPUT", "messages are JSON");
    }
    const channel = typeof m.channel === "string" && m.channel.length < 160 ? m.channel : null;
    if (!channel) return err(ws, null, "INVALID_INPUT", "channel is required");
    if (m.op === "unsub") {
      ws.data.subs.get(channel)?.();
      ws.data.subs.delete(channel);
      return send(ws, { type: "unsubscribed", channel });
    }
    if (m.op === "resync" && channel.startsWith("book:")) return snapshot(ws, channel.slice(5));
    if (m.op !== "sub") return err(ws, channel, "INVALID_INPUT", "op must be sub, unsub or resync");
    if (ws.data.subs.has(channel)) return send(ws, { type: "subscribed", channel });
    const isPrivate = PRIVATE_PREFIXES.some((p) => channel.startsWith(p));
    if (!isPrivate && !PUBLIC_PREFIXES.some((p) => channel.startsWith(p))) return err(ws, channel, "NOT_FOUND", "unknown channel");
    if (isPrivate) {
      const a = await authorise(channel, m);
      if (!a.ok) return err(ws, channel, "UNAUTHORIZED", `subscribe refused: ${a.why}`);
      if (!ws.data.owner) {
        ws.data.owner = a.owner;
        ws.data.cap = Math.max(ws.data.cap, await deps.capOf(a.owner));
      }
    }
    if (ws.data.subs.size >= ws.data.cap) return err(ws, channel, "VENUE_RATE_LIMITED", `this connection is at its ${ws.data.cap} subscription limit`);
    let off: () => void;
    const id = channel.slice(channel.indexOf(":") + 1);
    if (channel.startsWith("markets.ticker:")) off = await addTicker(ws, id);
    else if (channel.startsWith("book:")) {
      off = addBook(ws, id);
      await snapshot(ws, id);
    } else if (channel.startsWith("funding:")) off = forward(ws, channel, PUBSUB.funding(id));
    else if (channel.startsWith("account:")) off = forward(ws, channel, PUBSUB.account(id.toLowerCase()));
    else if (channel.startsWith("risk:")) off = forward(ws, channel, PUBSUB.risk(id.toLowerCase()));
    else if (channel.startsWith("receipts:")) off = forward(ws, channel, PUBSUB.receipts(id.toLowerCase()));
    else off = forward(ws, channel, PUBSUB.plan(id));
    ws.data.subs.set(channel, off);
    send(ws, { type: "subscribed", channel });
  }

  let open = 0;
  return {
    async start(port: number, hostname = "127.0.0.1"): Promise<Server<ConnState>> {
      const anonCap = await deps.capOf(null);
      return Bun.serve<ConnState>({
        port,
        hostname,
        fetch(req, server) {
          const u = new URL(req.url);
          SERVICE_METRICS.httpRequests.inc("ws");
          if (u.pathname === "/health") return Response.json({ ok: true, service: "ws" });
          if (u.pathname === "/v1" && server.upgrade(req, { data: { subs: new Map(), owner: null, cap: anonCap, bookSeq: new Map() } })) return undefined;
          return Response.json({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 });
        },
        websocket: {
          open() {
            SERVICE_METRICS.wsConnections.set(++open);
          },
          message: (ws, raw) => void onMessage(ws, raw as string),
          close(ws) {
            SERVICE_METRICS.wsConnections.set(Math.max(0, --open));
            for (const off of ws.data.subs.values()) off();
            ws.data.subs.clear();
          },
        },
      });
    },
    stop() {
      clearInterval(timer);
    },
    stats: () => ({ tickers: tickers.size, books: books.size }),
  };
}
