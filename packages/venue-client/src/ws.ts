// Venue WebSocket client. Spreads subscriptions over at most `maxConns` connections of `maxSubs` each, opens at most
// `maxNewPerMin` connections per rolling minute (Hyperliquid: 10 connections, 30 new per minute, 1,000 subscriptions
// per IP), reconnects with jittered exponential backoff after a close, and sends every active subscription again
// exactly once on the new connection. Messages on a connection go to every subscriber on it; adapters filter.
import type { Unsubscribe } from "@capstan/schema";
import type { VenueKey } from "./budgets";

export interface VenueWsOptions {
  maxConns: number;
  maxNewPerMin: number;
  maxSubs: number;
  pingMs: number;
  pingMessage?: unknown; // default {"method":"ping"} (Hyperliquid); null disables pings
  unsubscribeMessage?: (subscribeMsg: unknown) => unknown | null;
  newConnWindowMs?: number; // default 60 000 (tests shorten it)
  backoffBaseMs?: number; // default 500
  backoffMaxMs?: number; // default 30 000
  onError?: (e: unknown) => void;
  /**
   * User-Agent sent on the upgrade. Some venue CDNs refuse an upgrade without one (Lighter RH testnet answers 403),
   * and the runtime sends none by default. Default "capstan-ws".
   */
  userAgent?: string;
}

/** A WebSocket failure with the runtime's real text (an ErrorEvent prints as "[object ErrorEvent]"). */
export class VenueWsError extends Error {
  readonly venue: string;
  readonly url: string;
  /** HTTP status of a refused upgrade ("Expected 101 status code: 400"), when the runtime reports one. */
  readonly httpStatus: number | null;
  constructor(venue: string, url: string, message: string) {
    super(`${venue} ws ${url}: ${message}`);
    this.name = "VenueWsError";
    this.venue = venue;
    this.url = url;
    const m = /status code:?\s*(\d{3})/i.exec(message);
    this.httpStatus = m ? Number(m[1]) : null;
  }
}

/** The text of any error a socket hands us: ErrorEvent.message, its .error, an Error, or the value itself. */
export function wsErrorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const x = e as { message?: unknown; error?: unknown; type?: unknown; code?: unknown; reason?: unknown };
    if (typeof x.message === "string" && x.message) return x.message;
    if (x.error instanceof Error && x.error.message) return x.error.message;
    if (typeof x.reason === "string" && x.reason) return `${x.code ?? ""} ${x.reason}`.trim();
    if (typeof x.type === "string") return `${x.type} event with no message`;
  }
  return String(e);
}

export interface VenueWs {
  subscribe(msg: unknown, onMsg: (m: unknown) => void): Unsubscribe;
  close(): void;
  /** Introspection for tests and metrics. */
  stats(): { connections: number; opened: number; subscriptions: number; openedAt: number[] };
}

interface Sub {
  id: number;
  msg: unknown;
  onMsg: (m: unknown) => void;
}

interface Conn {
  ws: WebSocket | null;
  open: boolean;
  subs: Map<number, Sub>;
  attempts: number;
  ping?: ReturnType<typeof setInterval>;
  reconnect?: ReturnType<typeof setTimeout>;
}

function jitter(ms: number): number {
  const r = crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
  return Math.round(ms * (0.5 + r * 0.5));
}

export function venueWs(venue: VenueKey, url: string, opts: VenueWsOptions): VenueWs {
  const windowMs = opts.newConnWindowMs ?? 60_000;
  const base = opts.backoffBaseMs ?? 500;
  const maxBackoff = opts.backoffMaxMs ?? 30_000;
  const pingMsg = opts.pingMessage === undefined ? { method: "ping" } : opts.pingMessage;
  const conns: Conn[] = [];
  const openTimes: number[] = [];
  let opened = 0;
  const openHistory: number[] = []; // every connection attempt time (bounded), for tests and metrics
  let nextId = 1;
  let closed = false;

  const send = (c: Conn, m: unknown) => {
    if (c.ws && c.open) c.ws.send(typeof m === "string" ? m : JSON.stringify(m));
  };

  /** ms to wait before another connection may open under maxNewPerMin. */
  const openDelay = (): number => {
    const t = Date.now();
    while (openTimes.length && openTimes[0]! <= t - windowMs) openTimes.shift();
    if (openTimes.length < opts.maxNewPerMin) return 0;
    return openTimes[0]! + windowMs - t + 1;
  };

  const connect = (c: Conn) => {
    if (closed) return;
    const wait = openDelay();
    if (wait > 0) {
      c.reconnect = setTimeout(() => connect(c), wait);
      return;
    }
    const at = Date.now();
    openTimes.push(at);
    openHistory.push(at);
    if (openHistory.length > 1000) openHistory.shift();
    opened++;
    // Bun's WebSocket takes headers as a second argument; the DOM type does not know it
    const ws = new WebSocket(url, { headers: { "User-Agent": opts.userAgent ?? "capstan-ws" } } as unknown as string[]);
    c.ws = ws;
    ws.onopen = () => {
      c.open = true;
      c.attempts = 0;
      for (const s of c.subs.values()) send(c, s.msg); // each active subscription, once
      if (pingMsg !== null && opts.pingMs > 0) c.ping = setInterval(() => send(c, pingMsg), opts.pingMs);
    };
    ws.onmessage = (ev) => {
      let m: unknown = ev.data;
      if (typeof ev.data === "string") {
        try {
          m = JSON.parse(ev.data);
        } catch {
          m = ev.data;
        }
      }
      for (const s of c.subs.values()) {
        try {
          s.onMsg(m);
        } catch (e) {
          opts.onError?.(e);
        }
      }
    };
    ws.onerror = (e) => opts.onError?.(new VenueWsError(venue, url, wsErrorText(e)));
    ws.onclose = () => {
      c.open = false;
      if (c.ping) clearInterval(c.ping);
      c.ping = undefined;
      c.ws = null;
      if (closed) return;
      if (c.subs.size === 0) {
        conns.splice(conns.indexOf(c), 1);
        return;
      }
      const delay = Math.min(maxBackoff, jitter(base * 2 ** c.attempts));
      c.attempts++;
      c.reconnect = setTimeout(() => connect(c), delay);
    };
  };

  const pick = (): Conn => {
    const free = conns.find((c) => c.subs.size < opts.maxSubs);
    if (free) return free;
    if (conns.length >= opts.maxConns) throw new Error(`${venue} ws: every connection is full (${opts.maxConns} x ${opts.maxSubs} subscriptions)`);
    const c: Conn = { ws: null, open: false, subs: new Map(), attempts: 0 };
    conns.push(c);
    connect(c);
    return c;
  };

  return {
    subscribe(msg, onMsg) {
      if (closed) throw new Error(`${venue} ws: closed`);
      const c = pick();
      const s: Sub = { id: nextId++, msg, onMsg };
      c.subs.set(s.id, s);
      send(c, msg); // if the socket is not open yet, onopen sends it
      return () => {
        if (!c.subs.delete(s.id)) return;
        const un = opts.unsubscribeMessage?.(msg);
        if (un) send(c, un);
      };
    },
    close() {
      closed = true;
      for (const c of conns) {
        if (c.ping) clearInterval(c.ping);
        if (c.reconnect) clearTimeout(c.reconnect);
        c.ws?.close();
      }
      conns.length = 0;
    },
    stats() {
      return { connections: conns.filter((c) => c.open).length, opened, subscriptions: conns.reduce((n, c) => n + c.subs.size, 0), openedAt: [...openHistory] };
    },
  };
}
