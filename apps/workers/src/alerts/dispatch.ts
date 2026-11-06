// User alert delivery (spec 9 alerts): one POST per matching webhook, signed X-Capstan-Signature =
// hex HMAC-SHA256(webhook secret, body) with X-Capstan-Timestamp, sent to the guard-checked IP (no rebinding), no
// redirects, 5 s timeout, 3 retries with backoff. 20 consecutive failed deliveries disable the webhook with the reason
// visible to the owner. alert_events keeps only the payload hash (never the body or the URL query string).
// Webhooks are outbound only and never carry a user's signed payload or any key. User alerts never go to ops.
import { schema, ulid, type Db } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { createHash, createHmac } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { guardUrl, type Resolver } from "./guard";
import { pinnedHttps, type Transport } from "./transport";

export type AlertKind = "liq_distance" | "plan_unhedged" | "approval_expiry" | "policy_breach";
export const ALERT_KINDS: readonly AlertKind[] = ["liq_distance", "plan_unhedged", "approval_expiry", "policy_breach"];

export const TIMEOUT_MS = 5000;
export const RETRIES = 3;
export const DISABLE_AFTER = 20;
export const BACKOFF_MS = [1000, 2000, 4000] as const;

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
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const signBody = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

async function deliverOnce(url: string, body: string, headers: Record<string, string>, d: DispatchDeps): Promise<{ ok: boolean; reason: string }> {
  // the guard runs on every delivery (a host can change its answer); the request goes to the IP it checked
  const g = await guardUrl(url, d.resolver);
  if (!g.ok) return { ok: false, reason: `refused: ${g.reason}` };
  try {
    const r = await (d.http ?? pinnedHttps)({ ip: g.ip, family: g.family, host: g.host, port: g.port, path: g.path, headers, body, timeoutMs: TIMEOUT_MS });
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
  const hooks = await d.db
    .select()
    .from(schema.webhooks)
    .where(and(sql`lower(${schema.webhooks.owner}) = ${ev.owner.toLowerCase()}`, eq(schema.webhooks.disabled, false)));
  let delivered = 0;
  for (const w of hooks) {
    if (!w.kinds.includes(ev.kind)) continue;
    if (ev.dedupeKey) {
      const since = new Date(now.getTime() - (ev.dedupeWindowMs ?? 30 * 60_000));
      const seen = await d.db.select({ id: schema.alertEvents.id }).from(schema.alertEvents).where(and(eq(schema.alertEvents.webhookId, w.id), eq(schema.alertEvents.dedupeKey, ev.dedupeKey), gte(schema.alertEvents.ts, since))).orderBy(desc(schema.alertEvents.ts)).limit(1);
      if (seen.length) continue;
    }
    const id = ulid(now.getTime());
    const ts = now.toISOString();
    const body = JSON.stringify({ id, kind: ev.kind, owner: ev.owner.toLowerCase(), data: ev.data, ts });
    const secret = d.secretOf(w.id);
    if (sha256Hex(secret) !== w.secretHash) {
      // the server key changed since registration: never sign with a value the owner does not hold
      await d.db.update(schema.webhooks).set({ disabled: true, disabledReason: "the signing value no longer matches; register the webhook again" }).where(eq(schema.webhooks.id, w.id));
      continue;
    }
    const headers = { "content-type": "application/json", "user-agent": "capstan-alerts", "x-capstan-timestamp": ts, "x-capstan-signature": signBody(secret, body), "x-capstan-alert-id": id };
    let attempts = 0;
    let res = { ok: false, reason: "" };
    for (; attempts <= RETRIES; attempts++) {
      res = await deliverOnce(w.url, body, headers, d);
      if (res.ok || res.reason.startsWith("refused:") || res.reason.startsWith("redirect")) {
        attempts++;
        break;
      }
      if (attempts < RETRIES) await (d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(BACKOFF_MS[attempts]!);
    }
    attempts = Math.min(attempts, RETRIES + 1);
    await d.db.insert(schema.alertEvents).values({ id, webhookId: w.id, kind: ev.kind, payloadHash: sha256Hex(body), status: res.ok ? "delivered" : "failed", attempts, ts: now, dedupeKey: ev.dedupeKey ?? null });
    if (res.ok) {
      delivered++;
      if (w.consecutiveFailures) await d.db.update(schema.webhooks).set({ consecutiveFailures: 0 }).where(eq(schema.webhooks.id, w.id));
    } else {
      const n = w.consecutiveFailures + 1;
      await d.db
        .update(schema.webhooks)
        .set({ consecutiveFailures: n, lastFailureAt: now, ...(n >= DISABLE_AFTER ? { disabled: true, disabledReason: `Turned off after ${DISABLE_AFTER} failed deliveries in a row. Last error: ${res.reason}` } : {}) })
        .where(eq(schema.webhooks.id, w.id));
    }
  }
  return delivered;
}
