// Ops events travel on Redis. Producers that already exist publish on the `ops.alert` pub/sub channel (catalog-sync,
// anchor, root-indexer, lighter-rh-health). Pub/sub drops messages when no one listens, so the ops-alerts worker also
// reads a durable list: `emitOpsEvent` does both (publish + RPUSH), and the worker's subscriber copies channel
// messages into the same list. Each event carries an id so a message seen on both paths is handled once.
import { randomUUID } from "node:crypto";
import type { OpsEvent } from "./causes";

export const OPS_ALERT_CHANNEL = "ops.alert";
export const OPS_ALERT_LIST = "capstan:ops-alert:queue";
export const OPS_ALERT_SEEN = "capstan:ops-alert:seen:";

export interface RedisLike {
  publish(channel: string, message: string): Promise<unknown>;
  rpush(key: string, ...values: string[]): Promise<unknown>;
  lpop(key: string, count: number): Promise<string[] | null>;
  set(key: string, value: string, mode: "EX", ttl: number, nx: "NX"): Promise<unknown>;
}

export type IdentifiedEvent = OpsEvent & { eventId: string; ts: string };

export function identify(e: OpsEvent, now = new Date()): IdentifiedEvent {
  const ev = e as Partial<IdentifiedEvent>;
  return { ...e, eventId: typeof ev.eventId === "string" ? ev.eventId : randomUUID(), ts: typeof ev.ts === "string" ? ev.ts : now.toISOString() };
}

/** Durable emit used by new code (monitors, deploy, backup). */
export async function emitOpsEvent(redis: RedisLike, e: OpsEvent, now = new Date()): Promise<IdentifiedEvent> {
  const ev = identify(e, now);
  const msg = JSON.stringify(ev);
  await redis.rpush(OPS_ALERT_LIST, msg);
  await redis.publish(OPS_ALERT_CHANNEL, msg);
  return ev;
}

/** Parse one message; anything that is not an object with a string kind becomes an unknown event. */
export function parseOpsEvent(raw: string): OpsEvent {
  try {
    const j = JSON.parse(raw) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j) && typeof (j as { kind?: unknown }).kind === "string") return j as OpsEvent;
  } catch {
    /* fall through */
  }
  return { kind: "ops.unparseable", detail: { length: raw.length } };
}

/** Take up to `max` queued events; events already handled (same eventId within 1 h) are skipped. */
export async function drainOpsEvents(redis: RedisLike, max = 100): Promise<OpsEvent[]> {
  const raw = (await redis.lpop(OPS_ALERT_LIST, max)) ?? [];
  const out: OpsEvent[] = [];
  for (const r of raw) {
    const e = parseOpsEvent(r);
    const id = (e as { eventId?: unknown }).eventId;
    if (typeof id === "string") {
      const fresh = await redis.set(OPS_ALERT_SEEN + id, "1", "EX", 3600, "NX");
      if (fresh !== "OK") continue;
    }
    out.push(e);
  }
  return out;
}
