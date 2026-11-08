// Live data for the owner's pages: the public Capstan API reads (markets, books, funding, venues, health, quotes) with
// one state model for every live view (loading, ok, empty, error, offline), plus the number formatting the views
// share. Plain functions over a fetch, so the unit tests drive them with a stub API. Nothing here signs or builds.
import type { FundingRowLike, Market, OrderBook, RouteQuote, VenueCapabilities, VenueId } from "./types";

export type LiveState<T> =
  | { kind: "loading" }
  | { kind: "ok"; data: T }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "offline" };

export class LiveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export interface Reader {
  readonly base: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

/** A reader over the API base (ending in /v1). Each call gives up after `timeoutMs`. */
export function createReader(o: { apiBase: string; fetch?: typeof fetch; timeoutMs?: number }): Reader {
  const base = o.apiBase.replace(/\/$/, "");
  const f = o.fetch ?? fetch.bind(globalThis);
  const timeoutMs = o.timeoutMs ?? 10_000;
  async function call<T>(path: string, init: RequestInit): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let r: Response;
    try {
      r = await f(`${base}${path}`, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
    const text = await r.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!r.ok) {
      const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
      throw new LiveError(e?.message ?? `The API answered with status ${r.status}.`, r.status, e?.code ?? null);
    }
    return body as T;
  }
  return {
    base,
    get: <T>(path: string) => call<T>(path, { headers: { accept: "application/json" } }),
    post: <T>(path: string, body: unknown) => call<T>(path, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}

const isOffline = (e: unknown, online: () => boolean) => !online() || (e instanceof TypeError && !(e instanceof LiveError)) || (e as Error)?.name === "AbortError";

/** Runs a read and turns the result into a view state. A network failure or a browser that says it is offline is "offline". */
export async function readLive<T>(fn: () => Promise<T>, o: { isEmpty?: (d: T) => boolean; online?: () => boolean } = {}): Promise<LiveState<T>> {
  const online = o.online ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  try {
    const data = await fn();
    if (o.isEmpty?.(data)) return { kind: "empty" };
    return { kind: "ok", data };
  } catch (e) {
    if (isOffline(e, online)) return { kind: "offline" };
    return { kind: "error", message: (e as Error)?.message || "The API could not be read." };
  }
}

// ---- API reads ---------------------------------------------------------------------------------------------------

export const listMarkets = async (r: Reader, q: { venue?: VenueId; asset?: string; executable?: boolean } = {}) => {
  const p = new URLSearchParams();
  if (q.venue) p.set("venue", q.venue);
  if (q.asset) p.set("asset", q.asset);
  if (q.executable !== undefined) p.set("executable", String(q.executable));
  const qs = p.toString();
  const j = await r.get<{ markets: Market[] }>(`/markets${qs ? `?${qs}` : ""}`);
  return Array.isArray(j?.markets) ? j.markets : [];
};

export const readBook = (r: Reader, marketId: string, depth = 10) => r.get<OrderBook>(`/markets/${encodeURIComponent(marketId)}/book?depth=${depth}`);

export const readFunding = async (r: Reader, asset: string) => {
  const j = await r.get<{ asset: string; note?: string; rows: FundingRowLike[] }>(`/funding?asset=${encodeURIComponent(asset)}`);
  return { asset: j.asset, note: j.note ?? null, rows: Array.isArray(j?.rows) ? j.rows : [] };
};

export const readVenues = async (r: Reader) => {
  const j = await r.get<VenueCapabilities[]>("/venues");
  return Array.isArray(j) ? j : [];
};

export const readHealth = async (r: Reader) => {
  const j = await r.get<{ ok?: boolean }>("/health");
  return j?.ok === true;
};

export const readQuote = (r: Reader, req: { canonicalAsset: string; side: "buy" | "sell"; sizeBase: string; leverage: number; holdHours: number }) =>
  r.post<RouteQuote>("/quote", { ...req, orderType: "market" });

// ---- derived values ----------------------------------------------------------------------------------------------

/** Canonical assets that have at least one market, majors first, then by name. */
export function assetsOf(markets: Market[]): string[] {
  const seen = new Set<string>();
  for (const m of markets) if (m.canonicalAsset && m.marketType === "perp") seen.add(m.canonicalAsset);
  const order = ["CR:BTC", "CR:ETH", "CR:SOL"];
  return [...seen].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b);
  });
}

/** The asset part people read ("BTC" for "CR:BTC", "TSLA" for "EQ:TSLA"). */
export const assetLabel = (a: string) => a.split(":").pop() ?? a;

export interface BookStats {
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spreadBps: number | null;
  bidDepth: number;
  askDepth: number;
}

export function bookStats(b: OrderBook): BookStats {
  const num = (x: string | undefined) => (x === undefined ? null : Number(x));
  const bestBid = num(b.bids[0]?.[0]);
  const bestAsk = num(b.asks[0]?.[0]);
  const ok = (x: number | null): x is number => x !== null && Number.isFinite(x) && x > 0;
  const mid = ok(bestBid) && ok(bestAsk) ? (bestBid + bestAsk) / 2 : null;
  const spreadBps = mid && ok(bestBid) && ok(bestAsk) ? ((bestAsk - bestBid) / mid) * 10_000 : null;
  const sum = (side: [string, string][]) => side.reduce((s, [, sz]) => s + (Number.isFinite(Number(sz)) ? Number(sz) : 0), 0);
  return { bestBid: ok(bestBid) ? bestBid : null, bestAsk: ok(bestAsk) ? bestAsk : null, mid, spreadBps, bidDepth: sum(b.bids), askDepth: sum(b.asks) };
}

/** Capstan's default builder fee on a venue (bps), from GET /venues. Null when the venue has no builder rail. */
export function builderFeeBps(venues: VenueCapabilities[], venue: VenueId): number | null {
  const v = venues.find((x) => x.venue === venue);
  if (!v?.builderFee) return null;
  return typeof v.builderFee.chargeBps === "number" ? v.builderFee.chargeBps : null;
}

/** Builder fee in USD on a notional at a fee in bps. */
export const builderFeeUsd = (notionalUsd: number, bps: number) => (notionalUsd * bps) / 10_000;

// ---- formatting --------------------------------------------------------------------------------------------------

export function fmtPrice(x: number | string | null | undefined): string {
  const n = typeof x === "string" ? Number(x) : x;
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  const digits = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
}

export const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function fmtSize(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 2 : 4 });
}

/** A rate given as a fraction ("0.0000125") shown as a percent with enough digits to see it. */
export function fmtRatePct(x: string | number | null | undefined, digits = 4): string {
  const n = typeof x === "string" ? Number(x) : x;
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  return `${(n * 100).toFixed(digits)}%`;
}

export const fmtBps = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `${Number.isInteger(n) ? n : n.toFixed(2)} bps`);

export function fmtInterval(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "n/a";
  if (seconds % 3600 === 0) return seconds === 3600 ? "every hour" : `every ${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `every ${seconds / 60} minutes`;
  return `every ${seconds} s`;
}

/** Time left until an ISO time ("12 min", "1 h 05 min", "due now"). */
export function fmtUntil(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "n/a";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "n/a";
  const s = Math.round((t - nowMs) / 1000);
  if (s <= 0) return "due now";
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** Clock time in UTC ("14:00 UTC"), the way funding settlement times are published. */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "n/a";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "n/a";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** "12 s ago" style age of a reading. */
export function fmtAge(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "n/a";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "n/a";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
