// Venue HTTP client: every call takes its cost from the budget governor first, reports the response back to it, and
// parses JSON losslessly (venue ids above 2^53 - 1 stay strings).
// Retries: GET reads and Hyperliquid POST /info reads retry 5xx, timeouts, network errors and 429 (after the cool-off)
// with jittered exponential backoff, at most 3 tries. Any other POST (an exchange action, Lighter sendTx, an Aster
// order) is never retried: a duplicate order is worse than a failed one. The raw response is always available so an
// adapter can resolve an unclear outcome itself (Lighter: check the tx and nextNonce before any resend).
import { CapstanError } from "@capstan/schema";
import { arcusWeight, asterWeight, hlExchangeWeight, hlInfoWeight, HL_INFO_PER_ITEMS, type Priority, type VenueKey } from "./budgets";
import { currentRecorder } from "./record-context";
import { currentVenueLane, LANE_DEADLINE_MS } from "./lane-context";
import type { Governor } from "./governor";
import { parseJsonLossless } from "./json";

export type Method = "GET" | "POST" | "DELETE";

export interface RawResponse {
  httpStatus: number;
  headers: Headers;
  text: string;
  body: unknown; // lossless JSON when the body is JSON, else the text
}

/** Aster answers 503 when the outcome is unknown (the request may or may not have executed): reconcile, never assume. */
export interface UnknownOutcome {
  status: "unknown";
  httpStatus: number;
  venue: VenueKey;
  path: string;
  body: unknown;
}

export function isUnknownOutcome(x: unknown): x is UnknownOutcome {
  return !!x && typeof x === "object" && (x as { status?: unknown }).status === "unknown" && typeof (x as { httpStatus?: unknown }).httpStatus === "number";
}

export class VenueHttpError extends CapstanError {
  readonly httpStatus: number;
  readonly body: unknown;
  readonly venue: VenueKey;
  readonly path: string;
  constructor(venue: VenueKey, path: string, httpStatus: number, body: unknown, code: "VENUE_ERROR" | "VENUE_RATE_LIMITED" = "VENUE_ERROR") {
    const excerpt = typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body ?? null).slice(0, 200);
    super(code, `${venue} ${path}: HTTP ${httpStatus} ${excerpt}`);
    this.name = "VenueHttpError";
    this.httpStatus = httpStatus;
    this.body = body;
    this.venue = venue;
    this.path = path;
  }
}

export interface VenueHttp {
  getJson<T>(path: string, q?: Record<string, string | number>, cost?: number): Promise<T>;
  postJson<T>(path: string, body: unknown, cost?: number): Promise<T>;
  postForm<T>(path: string, form: Record<string, string>, cost?: number): Promise<T>;
  /** Raw access: one governed request, no status handling beyond the governor feedback. Never retried. */
  request(method: Method, path: string, init?: { query?: Record<string, string | number>; json?: unknown; form?: Record<string, string>; cost?: number }): Promise<RawResponse>;
}

export interface VenueHttpOptions {
  timeoutMs?: number;
  userAgent?: string;
  /** Lane when the caller names none with withVenueLane (default free). */
  priority?: Priority;
  /** Budget wait per request when the lane names none (default LANE_DEADLINE_MS for the lane). */
  deadlineMs?: number;
  maxTries?: number;
  backoffBaseMs?: number;
  fetchImpl?: typeof fetch;
}

/** True when a request is a read that may be retried. Exchange, sendTx and order posts never are. */
export function isRetryableRead(venue: VenueKey, method: Method, path: string): boolean {
  if (method === "GET") return true;
  return method === "POST" && venue.startsWith("hyperliquid") && path === "/info";
}

/** Default cost of a call from the venue's weight table. */
export function defaultCost(venue: VenueKey, method: Method, path: string, query: Record<string, string | number> = {}, json?: unknown): number {
  if (venue.startsWith("hyperliquid")) {
    if (path === "/info") return hlInfoWeight(String((json as { type?: unknown } | undefined)?.type ?? ""));
    if (path === "/exchange") {
      const orders = (json as { action?: { orders?: unknown[]; cancels?: unknown[] } } | undefined)?.action;
      return hlExchangeWeight(orders?.orders?.length ?? orders?.cancels?.length ?? 1);
    }
  }
  if (venue.startsWith("aster")) return asterWeight(path, query);
  if (venue.startsWith("arcus")) return arcusWeight(path);
  void method;
  return 1;
}

function jitter(ms: number): number {
  const r = crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
  return Math.round(ms * (0.5 + r * 0.5));
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number>): string {
  const u = new URL(baseUrl.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`));
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
  return u.toString();
}

export function venueHttp(venue: VenueKey, baseUrl: string, gov: Governor, opts: VenueHttpOptions = {}): VenueHttp {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxTries = Math.max(1, Math.min(opts.maxTries ?? 3, 3));
  const base = opts.backoffBaseMs ?? 200;
  const priority = opts.priority ?? "free";
  const doFetch = opts.fetchImpl ?? fetch;
  const ua = opts.userAgent ?? "capstan-venue-client";

  async function once(method: Method, path: string, init: { query?: Record<string, string | number>; json?: unknown; form?: Record<string, string>; cost?: number }): Promise<RawResponse> {
    const rec = currentRecorder();
    if (rec) rec.check(venue, method, path);
    const cost = init.cost ?? defaultCost(venue, method, path, init.query, init.json);
    // the caller's lane (withVenueLane) wins; every wait has a deadline and fails closed (D2-ADP-05)
    const lane = currentVenueLane();
    const prio: Priority = lane?.priority ?? priority;
    const deadlineMs = lane?.deadlineMs ?? opts.deadlineMs ?? LANE_DEADLINE_MS[prio];
    await gov.acquire(venue, cost, { priority: prio, deadlineMs });
    const headers: Record<string, string> = { "user-agent": ua, accept: "application/json" };
    let body: string | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    }
    const url = buildUrl(baseUrl, path, init.query);
    const res = await doFetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let parsed: unknown = text;
    if (text.length && /^[\s]*[[{"0-9tfn-]/.test(text)) {
      try {
        parsed = parseJsonLossless(text);
      } catch {
        parsed = text;
      }
    }
    gov.observe(venue, { status: res.status, headers: res.headers, body: parsed });
    // per-item info weights are only known after the response
    const t = (init.json as { type?: unknown } | undefined)?.type;
    if (venue.startsWith("hyperliquid") && path === "/info" && typeof t === "string" && HL_INFO_PER_ITEMS[t] && Array.isArray(parsed)) {
      const extra = hlInfoWeight(t, parsed.length) - hlInfoWeight(t, 0);
      if (extra > 0) await gov.acquire(venue, extra, { priority: prio, deadlineMs });
    }
    const raw = { httpStatus: res.status, headers: res.headers, text, body: parsed };
    if (rec) rec.capture(venue, method, url, init.json ?? init.form ?? null, raw);
    return raw;
  }

  async function call<T>(method: Method, path: string, init: { query?: Record<string, string | number>; json?: unknown; form?: Record<string, string>; cost?: number }): Promise<T> {
    const retryable = isRetryableRead(venue, method, path);
    const tries = retryable ? maxTries : 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt > 0) await Bun.sleep(jitter(base * 2 ** (attempt - 1)));
      let raw: RawResponse;
      try {
        raw = await once(method, path, init);
      } catch (e) {
        // governor refusal (ban, deadline) or a recorder refusal: never retried
        if (e instanceof CapstanError || (e as Error)?.name === "RecordRefused") throw e;
        lastErr = e; // network error or timeout
        continue;
      }
      const s = raw.httpStatus;
      if (s >= 200 && s < 300) return raw.body as T;
      if (s === 503 && venue.startsWith("aster")) return { status: "unknown", httpStatus: s, venue, path, body: raw.body } satisfies UnknownOutcome as T;
      if (s === 418) throw new VenueHttpError(venue, path, s, raw.body, "VENUE_RATE_LIMITED");
      if (s === 429) {
        lastErr = new VenueHttpError(venue, path, s, raw.body, "VENUE_RATE_LIMITED");
        continue; // the governor holds the next acquire until the cool-off ends
      }
      if (s >= 500) {
        lastErr = new VenueHttpError(venue, path, s, raw.body);
        continue;
      }
      throw new VenueHttpError(venue, path, s, raw.body);
    }
    if (lastErr instanceof VenueHttpError) throw lastErr;
    throw new VenueHttpError(venue, path, 0, lastErr instanceof Error ? `${lastErr.name}: ${lastErr.message}` : "network error");
  }

  return {
    getJson: (path, q, cost) => call("GET", path, { query: q, cost }),
    postJson: (path, body, cost) => call("POST", path, { json: body, cost }),
    postForm: (path, form, cost) => call("POST", path, { form, cost }),
    request: (method, path, init = {}) => once(method, path, init),
  };
}
