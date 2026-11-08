// User alert delivery (spec 9 alerts): one POST per matching webhook, signed X-Capstan-Signature =
// hex HMAC-SHA256(webhook secret, body) with X-Capstan-Timestamp, sent to the guard-checked IP (no rebinding), no
// redirects, 5 s timeout, 3 retries with backoff. 20 consecutive failed deliveries disable the webhook with the reason
// visible to the owner. alert_events keeps only the payload hash (never the body or the URL query string).
// Webhooks are outbound only and never carry a user's signed payload or any key. User alerts never go to ops.
// Bounded (R1-8-03): an owner's hooks are tried in parallel and the whole alert gets JOB_BUDGET_MS of wall time (each
// attempt is cut at its timeout or the budget, whichever is first, even if the host trickles bytes), the host lookup
// has its own limit, and alerts a wallet can cause itself (plan_unhedged, policy_breach) are capped per owner per minute.
// At the budget the request itself is aborted (its socket destroyed), and a hook that answers slower than SLOW_MS on
// SLOW_DISABLE_AFTER deliveries in a row is turned off with the reason shown to the owner.
import { schema, ulid, type Db } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { createHash, createHmac } from "node:crypto";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { guardUrl, LOOKUP_TIMEOUT_MS, type Resolver } from "./guard";
import { SLOW_DISABLE_AFTER, SLOW_MS, type SlowStreak } from "./owner-limits";
import { pinnedHttps, type Transport } from "./transport";

export type AlertKind = "liq_distance" | "plan_unhedged" | "approval_expiry" | "policy_breach";
export const ALERT_KINDS: readonly AlertKind[] = ["liq_distance", "plan_unhedged", "approval_expiry", "policy_breach"];

export const TIMEOUT_MS = 5000;
export const RETRIES = 3;
export const DISABLE_AFTER = 20;
export const BACKOFF_MS = [1000, 2000, 4000] as const;
/** Wall time one alert may hold a worker slot for, across all of the owner's hooks and retries. */
export const JOB_BUDGET_MS = 10_000;
/** Deliveries of caller-triggerable kinds per owner per minute (liq_distance and approval_expiry are not capped). */
export const USER_TRIGGERED_PER_MINUTE = 10;
export const USER_TRIGGERED_KINDS: readonly AlertKind[] = ["plan_unhedged", "policy_breach"];

export interface AlertEvent {
  kind: AlertKind;
  owner: Hex;
  data: unknown;
  /** One alert per key per window (rules set these). */
  dedupeKey?: string;
  dedupeWindowMs?: number;
}

export interface DispatchDeps {
  db: Db;
  http?: Transport;
  now: () => Date;
  /** The webhook's signing value (derived from the server key, never stored). */
  secretOf: (webhookId: string) => string;
  resolver?: Resolver;
  sleep?: (ms: number) => Promise<void>;
  /** Wall-time budget for this alert (default JOB_BUDGET_MS) and the clock it is measured on (monotonic ms). */
  budgetMs?: number;
  clock?: () => number;
  /** Slow-delivery streak per webhook (the job passes the Redis one); without it slow hooks are not turned off. */
  slow?: SlowStreak;
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const signBody = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

/**
 * Settle within ms, and call onTimeout when the time runs out (R1-8-03): the caller aborts the request there, so the
 * socket is destroyed at the budget, not only the wait for it.
 */
async function within<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>(
        (_, rej) =>
          (timer = setTimeout(() => {
            onTimeout?.();
            rej(new Error("timeout"));
          }, Math.max(0, ms))),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function deliverOnce(url: string, body: string, headers: Record<string, string>, d: DispatchDeps, left: () => number): Promise<{ ok: boolean; reason: string }> {
  // the guard runs on every delivery (a host can change its answer); the request goes to the IP it checked
  const g = await guardUrl(url, d.resolver, { lookupTimeoutMs: Math.min(LOOKUP_TIMEOUT_MS, left()) });
  if (!g.ok) return { ok: false, reason: `refused: ${g.reason}` };
  const timeoutMs = Math.min(TIMEOUT_MS, left());
  if (timeoutMs <= 0) return { ok: false, reason: "send failed: out of time" };
  const ac = new AbortController();
  try {
    const r = await within((d.http ?? pinnedHttps)({ ip: g.ip, family: g.family, host: g.host, port: g.port, path: g.path, headers, body, timeoutMs, signal: ac.signal }), timeoutMs, () => ac.abort());
    if (r.status >= 300 && r.status < 400) return { ok: false, reason: `redirect ${r.status} not followed` };
    if (r.status < 200 || r.status >= 300) return { ok: false, reason: `HTTP ${r.status}` };
    return { ok: true, reason: "" };
  } catch (e) {
    return { ok: false, reason: `send failed: ${(e as Error).message}`.slice(0, 160) };
  }
}

/** Deliver one alert to every enabled webhook of the owner that asked for its kind. Returns deliveries that succeeded. */
export async function dispatch(ev: AlertEvent, d: DispatchDeps): Promise<number> {
  const now = d.now();
  const clock = d.clock ?? (() => performance.now());
  const deadline = clock() + (d.budgetMs ?? JOB_BUDGET_MS);
  const left = () => deadline - clock();
  const hooks = (
    await d.db
      .select()
      .from(schema.webhooks)
      .where(and(sql`lower(${schema.webhooks.owner}) = ${ev.owner.toLowerCase()}`, eq(schema.webhooks.disabled, false)))
  ).filter((w) => w.kinds.includes(ev.kind));
  if (!hooks.length) return 0;
  if (USER_TRIGGERED_KINDS.includes(ev.kind)) {
    // a wallet can end its own plans or trip its own policy at will: cap what that can send per minute
    const [row] = await d.db
      .select({ n: count() })
      .from(schema.alertEvents)
      .where(and(inArray(schema.alertEvents.webhookId, hooks.map((w) => w.id)), inArray(schema.alertEvents.kind, [...USER_TRIGGERED_KINDS]), gte(schema.alertEvents.ts, new Date(now.getTime() - 60_000))));
    if ((row?.n ?? 0) >= USER_TRIGGERED_PER_MINUTE) return 0;
  }
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const one = async (w: (typeof hooks)[number]): Promise<boolean> => {
    if (ev.dedupeKey) {
      const since = new Date(now.getTime() - (ev.dedupeWindowMs ?? 30 * 60_000));
      const seen = await d.db.select({ id: schema.alertEvents.id }).from(schema.alertEvents).where(and(eq(schema.alertEvents.webhookId, w.id), eq(schema.alertEvents.dedupeKey, ev.dedupeKey), gte(schema.alertEvents.ts, since))).orderBy(desc(schema.alertEvents.ts)).limit(1);
      if (seen.length) return false;
    }
    const id = ulid(now.getTime());
    const ts = now.toISOString();
    const body = JSON.stringify({ id, kind: ev.kind, owner: ev.owner.toLowerCase(), data: ev.data, ts });
    const secret = d.secretOf(w.id);
    if (sha256Hex(secret) !== w.secretHash) {
      // the server key changed since registration: never sign with a value the owner does not hold
      await d.db.update(schema.webhooks).set({ disabled: true, disabledReason: "the signing value no longer matches; register the webhook again" }).where(eq(schema.webhooks.id, w.id));
      return false;
    }
    const headers = { "content-type": "application/json", "user-agent": "capstan-alerts", "x-capstan-timestamp": ts, "x-capstan-signature": signBody(secret, body), "x-capstan-alert-id": id };
    let attempts = 0;
    let res = { ok: false, reason: "" };
    let slowest = 0;
    for (; attempts <= RETRIES; attempts++) {
      const t0 = clock();
      res = await deliverOnce(w.url, body, headers, d, left);
      slowest = Math.max(slowest, clock() - t0);
      if (res.ok || res.reason.startsWith("refused:") || res.reason.startsWith("redirect")) {
        attempts++;
        break;
      }
      // no retry that would end past the budget
      if (attempts < RETRIES && left() > BACKOFF_MS[attempts]!) await sleep(BACKOFF_MS[attempts]!);
      else {
        attempts++;
        break;
      }
    }
    attempts = Math.min(attempts, RETRIES + 1);
    await d.db.insert(schema.alertEvents).values({ id, webhookId: w.id, kind: ev.kind, payloadHash: sha256Hex(body), status: res.ok ? "delivered" : "failed", attempts, ts: now, dedupeKey: ev.dedupeKey ?? null });
    if (d.slow) {
      if (slowest > SLOW_MS) {
        if ((await d.slow.bump(w.id)) >= SLOW_DISABLE_AFTER) {
          await d.db.update(schema.webhooks).set({ disabled: true, disabledReason: `Turned off after answering slower than ${SLOW_MS / 1000} s on ${SLOW_DISABLE_AFTER} deliveries in a row.` }).where(eq(schema.webhooks.id, w.id));
          await d.slow.clear(w.id);
        }
      } else await d.slow.clear(w.id);
    }
    if (res.ok) {
      if (w.consecutiveFailures) await d.db.update(schema.webhooks).set({ consecutiveFailures: 0 }).where(eq(schema.webhooks.id, w.id));
      return true;
    }
    const n = w.consecutiveFailures + 1;
    await d.db
      .update(schema.webhooks)
      .set({ consecutiveFailures: n, lastFailureAt: now, ...(n >= DISABLE_AFTER ? { disabled: true, disabledReason: `Turned off after ${DISABLE_AFTER} failed deliveries in a row. Last error: ${res.reason}` } : {}) })
      .where(eq(schema.webhooks.id, w.id));
    return false;
  };
  // in parallel: one slow hook does not use up the others' time
  const done = await Promise.all(hooks.map(one));
  return done.filter(Boolean).length;
}
