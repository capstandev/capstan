// The fan-out bus: Redis pub/sub channels (core PUBSUB) with one subscription per channel shared by every socket
// that needs it, or an in-memory bus for tests and the load run.
import type { Redis } from "@capstan/core";

export interface Bus {
  sub(channel: string, fn: (payload: string) => void): () => void;
  publish?(channel: string, payload: string): void;
}

export function memoryBus(): Bus & { publish(channel: string, payload: string): void; count(channel: string): number } {
  const subs = new Map<string, Set<(p: string) => void>>();
  return {
    sub(ch, fn) {
      let s = subs.get(ch);
      if (!s) subs.set(ch, (s = new Set()));
      s.add(fn);
      return () => {
        s!.delete(fn);
        if (!s!.size) subs.delete(ch);
      };
    },
    publish(ch, p) {
      for (const fn of [...(subs.get(ch) ?? [])]) fn(p);
    },
    count: (ch) => subs.get(ch)?.size ?? 0,
  };
}

export function redisBus(redis: Redis): Bus & { close(): Promise<void> } {
  const conn = redis.duplicate();
  conn.on("error", () => undefined);
  const local = memoryBus();
  const refs = new Map<string, number>();
  conn.on("message", (ch: string, payload: string) => local.publish(ch, payload));
  return {
    sub(ch, fn) {
      const n = refs.get(ch) ?? 0;
      refs.set(ch, n + 1);
      if (n === 0) void conn.subscribe(ch).catch(() => undefined);
      const off = local.sub(ch, fn);
      return () => {
        off();
        const m = (refs.get(ch) ?? 1) - 1;
        if (m <= 0) {
          refs.delete(ch);
          void conn.unsubscribe(ch).catch(() => undefined);
        } else refs.set(ch, m);
      };
    },
    async close() {
      await conn.quit().catch(() => undefined);
    },
  };
}
