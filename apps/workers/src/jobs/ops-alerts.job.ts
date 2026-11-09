// Ops alerts worker (every 15 s): takes ops events from Redis (the `ops.alert` channel and the durable list), maps
// each to its glossary cause and sends one plain message per cause per 30 minutes to the internal ops group.
// Unarmed (ALERTS_ARMED unset) it only logs. Every 10 minutes it also runs the read-only builder balance check and
// refreshes the database gauges. It refuses to run when a cause in code is missing from ops/alerts/GLOSSARY.md.
// Notify only (MON-1): nothing here can stop the relay, kill an agent or flip a venue flag.
import type { JobDef, JobDeps, Redis } from "@capstan/core";
import { anchorLag } from "../anchor/anchor";
import {
  assertCausesKnown,
  CAUSES,
  checkBuilderBalances,
  drainOpsEvents,
  emitOpsEvent,
  hlBuilderReader,
  identify,
  OPS_ALERT_CHANNEL,
  OPS_ALERT_LIST,
  OPS_ALERT_SEEN,
  redisDedupe,
  refreshDbGauges,
  sendOpsAlert,
  toOpsAlert,
  type AsterBuilderReader,
  type DedupeStore,
  type HlBuilderReader,
  type OpsEvent,
} from "@capstan/telemetry";

export const BUILDER_CHECK_EVERY_MS = 10 * 60_000;
export const DEFAULT_TOKEN_FILE = "/etc/capstan/workers/telegram-token";

export interface OpsAlertsOptions {
  env?: Record<string, string | undefined>;
  http?: typeof fetch;
  dedupe?: DedupeStore;
  hl?: HlBuilderReader | null;
  aster?: AsterBuilderReader | null;
  /** Events to handle when there is no Redis (tests, dry runs). */
  events?: OpsEvent[];
  /** Wait before a Telegram 429 retry (default a real timer). */
  sleep?: (ms: number) => Promise<void>;
}

/** A failed alert is put back at most this many times (about 5 minutes at one run every 15 s), then dropped. */
export const MAX_ALERT_REQUEUES = 20;

export type OpsAlertResult = "sent" | "deduped" | "logged" | "failed";

let subscriber: Redis | null = null;
let lastBuilderCheck = 0;

/** Copy channel messages into the durable list (one subscriber per process). */
async function ensureSubscriber(redis: Redis, log: JobDeps["log"]): Promise<void> {
  if (subscriber) return;
  const sub = redis.duplicate();
  subscriber = sub;
  await sub.subscribe(OPS_ALERT_CHANNEL);
  sub.on("message", (_ch: string, msg: string) => {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(msg) as Record<string, unknown>;
    } catch {
      e = { kind: "ops.unparseable" };
    }
    redis.rpush(OPS_ALERT_LIST, JSON.stringify(identify(e as OpsEvent))).catch((err: Error) => log.error("ops alert queue push failed", { error: err.message }));
  });
}

export async function stopOpsAlertsSubscriber(): Promise<void> {
  const s = subscriber;
  subscriber = null;
  if (s) await s.quit().catch(() => undefined);
}

export function resetOpsAlertsState(): void {
  lastBuilderCheck = 0;
}

export async function runOpsAlerts(deps: JobDeps, o: OpsAlertsOptions = {}) {
  assertCausesKnown(Object.keys(CAUSES)); // R9: refuse to run with a cause the glossary does not explain
  const env = o.env ?? process.env;
  const nowMs = deps.now().getTime();
  const pending: OpsEvent[] = [...(o.events ?? [])];
  const emit = async (e: OpsEvent) => {
    if (deps.redis) await emitOpsEvent(deps.redis, e, deps.now());
    else pending.push(e);
  };

  if (nowMs - lastBuilderCheck >= BUILDER_CHECK_EVERY_MS) {
    lastBuilderCheck = nowMs;
    const hlAddr = env.HL_BUILDER_ADDRESS;
    const hl = o.hl !== undefined ? o.hl : hlAddr ? hlBuilderReader(hlAddr, o.http ?? fetch) : null;
    // TODO(owner): the Aster builder balance is a signed builder read that runs on the VPS only (BACKLOG A4, E3);
    // the VPS wiring passes its reader here. Without it the Aster check is skipped, never guessed.
    const aster = o.aster ?? null;
    if (hl || aster) await checkBuilderBalances({ hl: hl ?? undefined, aster: aster ?? undefined, emit });
    if (deps.db) await refreshDbGauges(deps.db).catch((e: Error) => deps.log.warn("db gauges refresh failed", { error: e.message }));
    // r1:6 F10: anchoring that has stopped or keeps failing is paged, read from the database so a dead RPC still fires
    if (deps.db) {
      const lag = await anchorLag(deps.db, deps.now()).catch((e: Error) => (deps.log.warn("anchor lag check failed", { error: e.message }), null));
      if (lag) await emit({ kind: "anchor.lagging", severity: "critical", detail: lag });
    }
  }

  if (deps.redis) {
    await ensureSubscriber(deps.redis, deps.log);
    pending.push(...(await drainOpsEvents(deps.redis)));
  }

  const armed = env.ALERTS_ARMED === "1" || env.ALERTS_ARMED === "true";
  const dedupe = o.dedupe ?? (deps.redis ? redisDedupe(deps.redis) : undefined);
  const known = (env.OPS_KNOWN_ADDRESSES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const results: { cause: string; result: OpsAlertResult }[] = [];
  for (const e of pending) {
    const a = toOpsAlert(e);
    try {
      const result = await sendOpsAlert(a, {
        armed,
        tokenFile: env.ALERTS_TOKEN_FILE ?? DEFAULT_TOKEN_FILE,
        chatId: env.ALERTS_CHAT_ID ?? "",
        dedupeMinutes: 30,
        http: o.http ?? fetch,
        apiBase: env.ALERTS_TELEGRAM_API,
        now: () => deps.now().getTime(),
        ...(o.sleep ? { sleep: o.sleep } : {}),
        dedupe,
        log: deps.log,
        knownAddresses: known,
      });
      results.push({ cause: a.cause, result });
    } catch (err) {
      // one failed send (network, 5xx, a long 429) must not drop the other drained events: they are still sent, and
      // this one goes back on the durable list for the next run (its seen mark is cleared so the drain takes it again)
      results.push({ cause: a.cause, result: "failed" });
      deps.log.error("ops alert failed, kept for the next run", { cause: a.cause, error: (err as Error).message });
      const tries = Number((e as { requeues?: unknown }).requeues ?? 0) || 0;
      if (deps.redis && tries >= MAX_ALERT_REQUEUES) {
        deps.log.error("ops alert dropped after repeated failures", { cause: a.cause, requeues: tries });
      } else if (deps.redis) {
        const id = (e as { eventId?: unknown }).eventId;
        try {
          if (typeof id === "string") await deps.redis.del(OPS_ALERT_SEEN + id);
          await deps.redis.rpush(OPS_ALERT_LIST, JSON.stringify({ ...e, requeues: tries + 1 }));
        } catch (qe) {
          deps.log.error("ops alert requeue failed", { cause: a.cause, error: (qe as Error).message });
        }
      }
    }
  }
  return results;
}

export const job: JobDef = {
  name: "ops-alerts",
  queue: "opsAlerts", // its own queue: user webhooks can never delay a page to the team (R1-8-03)
  schedule: { every: 15_000 },
  concurrency: 1,
  handler: (_job, deps) => runOpsAlerts(deps),
};
