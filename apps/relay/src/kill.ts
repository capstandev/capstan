// The relay's kill view (spec 7.6, todo 22): an in-memory set fed by the `ps:kill` subscription, so a kill reaches
// the relay in well under a second, plus a GET of `kill:<agentRef>` for anything the set does not hold. When Redis
// cannot answer the view says 'unknown'; the pipeline then refuses every agent that runs under a policy (fail closed).
import type { Redis } from "@capstan/core";
// the relay only READS the kill flag (MON-1: nothing here ever sets one)
import { KILL_CHANNEL, killKey as killFlagOf } from "@capstan/policy";
import type { KillView } from "./types";

export interface RedisKillView extends KillView {
  ready: Promise<void>;
  close(): Promise<void>;
}

export function redisKillView(redis: Redis, o: { getTimeoutMs?: number } = {}): RedisKillView {
  const killed = new Set<string>();
  const sub = redis.duplicate();
  sub.on("message", (channel: string, ref: string) => {
    if (channel === KILL_CHANNEL) killed.add(ref);
  });
  sub.on("error", () => undefined);
  // a failed subscription leaves the GET path, which fails closed on its own
  const ready = sub.subscribe(KILL_CHANNEL).then(
    () => undefined,
    () => undefined,
  );
  const timeout = o.getTimeoutMs ?? 300;
  return {
    ready,
    async status(agentRef) {
      if (killed.has(agentRef)) return "killed";
      try {
        const v = await Promise.race([redis.get(killFlagOf(agentRef)), Bun.sleep(timeout).then(() => Promise.reject(new Error("redis timeout")))]);
        if (v !== null) {
          killed.add(agentRef);
          return "killed";
        }
        return "ok";
      } catch {
        return "unknown";
      }
    },
    async close() {
      await ready.catch(() => undefined);
      await sub.quit().catch(() => undefined);
    },
  };
}

export function memoryKillView(): KillView & { markKilled(ref: string): void; down: boolean } {
  const killed = new Set<string>();
  const v = {
    down: false,
    markKilled: (ref: string) => void killed.add(ref),
    async status(ref: string) {
      if (killed.has(ref)) return "killed" as const;
      return v.down ? ("unknown" as const) : ("ok" as const);
    },
  };
  return v;
}
