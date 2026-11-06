// In-process priority dispatcher for venue submits: safety (cancels, close-all) first, then pro, then free. Jobs of one
// priority run in arrival order. The relay worker consumes the relay-submit queue and every submit passes through
// here, so under load a pro job never waits behind queued free jobs.
import type { Priority } from "@capstan/venue-client";
import type { Dispatcher } from "./types";

const RANK: Record<Priority, number> = { safety: 0, pro: 1, free: 2 };

export function priorityDispatcher(concurrency = 4): Dispatcher & { pending(): number; order: string[] } {
  const queues: (() => void)[][] = [[], [], []];
  let running = 0;
  const order: string[] = [];
  const pump = () => {
    while (running < concurrency) {
      const q = queues.find((x) => x.length > 0);
      if (!q) return;
      running++;
      q.shift()!();
    }
  };
  return {
    order,
    pending: () => queues.reduce((n, q) => n + q.length, 0),
    run<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queues[RANK[priority]]!.push(() => {
          order.push(priority);
          fn()
            .then(resolve, reject)
            .finally(() => {
              running--;
              pump();
            });
        });
        pump();
      });
    },
  };
}
