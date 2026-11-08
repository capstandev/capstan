// In-process priority dispatcher for venue submits: safety (cancels, close-all) first, then pro, then free. Jobs of one
// priority run in arrival order. The relay worker consumes the relay-submit queue and every submit passes through
// here, so under load a pro job never waits behind queued free jobs.
// Each venue budget key has its own slots and its own bounded wait line (security r1 R1-02): a job waiting for one
// venue's budget never holds a slot another venue needs, and a full line refuses with VENUE_RATE_LIMITED.
// Exits stay prioritised under a flood (R1-02 delta):
// - a full line never refuses a job while a lower-priority job is waiting in it: the newest waiting job of the
//   lowest priority is refused instead, so a safety job always gets in ahead of opening traffic;
// - opening jobs (pro, free) may hold at most `concurrency` running slots per key; safety jobs may also use
//   `safetyReserve` more, so a key full of opening jobs still starts a cancel at once;
// - `maxOpenJobs` bounds opening jobs (running and waiting) across every key, so opening traffic can never take every
//   relay worker slot (RELAY_WORKER_CONCURRENCY is above it) and safety jobs always find a worker.
// Exits are fair between owners (security r2 R2-RELAY-02): one owner (wallet) holds at most `maxSafetyPerOwner`
// safety places (running plus waiting) per key, a free safety slot goes to the waiting owner with the fewest running
// exits, and when the line is full a newcomer takes the place of the newest waiting exit of the owner holding the
// most places. So one actor's flood of reduce-only orders cannot refuse every other user's cancel or close.
import { CapstanError } from "@capstan/schema";
import type { Priority } from "@capstan/venue-client";
import type { Dispatcher } from "./types";

/**
 * Opening jobs (pro and free) the relay dispatcher holds across every venue key. Each key holds at most 24 of them
 * (8 running + 16 waiting), so 8 stalled keys reach this cap; past it opening submits are refused at once.
 */
export const RELAY_MAX_OPEN_JOBS = 192;

const RANK: Record<Priority, number> = { safety: 0, pro: 1, free: 2 };

/** Safety places (running plus waiting) one owner may hold per venue key: room for a close-all over 8 markets. */
export const SAFETY_PER_OWNER = 8;

interface Entry {
  seq: number;
  rank: number;
  owner: string | null;
  start(): void;
  refuse(e: Error): void;
}

interface Lane {
  key: string;
  queues: Entry[][];
  running: number;
  openRunning: number;
  /** Safety jobs running, per owner. */
  ownerRunning: Map<string, number>;
}

export interface DispatcherOptions {
  /** Waiting jobs per key (all priorities) before the lowest-priority newest one is refused. */
  maxQueuedPerKey?: number;
  /** Extra running slots per key only safety jobs may use (default: `concurrency`). */
  safetyReserve?: number;
  /** Opening jobs (pro and free, running and waiting) across every key. */
  maxOpenJobs?: number;
  /** Safety places (running plus waiting) per owner per key (default SAFETY_PER_OWNER). */
  maxSafetyPerOwner?: number;
}

export function priorityDispatcher(concurrency = 4, o: DispatcherOptions = {}): Dispatcher & { pending(): number; openJobs(): number; order: string[] } {
  const maxQueued = o.maxQueuedPerKey ?? Number.POSITIVE_INFINITY;
  const reserve = o.safetyReserve ?? concurrency;
  const maxOpen = o.maxOpenJobs ?? Number.POSITIVE_INFINITY;
  const perOwner = o.maxSafetyPerOwner ?? SAFETY_PER_OWNER;
  const lanes = new Map<string, Lane>();
  const order: string[] = [];
  let seq = 0;
  let openTotal = 0;
  const laneOf = (key: string): Lane => {
    let l = lanes.get(key);
    if (!l) lanes.set(key, (l = { key, queues: [[], [], []], running: 0, openRunning: 0, ownerRunning: new Map() }));
    return l;
  };
  const canStart = (l: Lane, rank: number) => l.running < concurrency + reserve && (rank === 0 || l.openRunning < concurrency);
  const waitingIn = (l: Lane) => l.queues.reduce((n, q) => n + q.length, 0);
  const refused = (key: string, why: string) => new CapstanError("VENUE_RATE_LIMITED", `${key}: ${why}`);
  /** Safety places an owner holds in a lane: running plus waiting. */
  const held = (l: Lane, owner: string) => (l.ownerRunning.get(owner) ?? 0) + l.queues[0]!.filter((e) => e.owner === owner).length;
  /** The waiting safety job to start next: the owner with the fewest running exits, then arrival order. */
  const nextSafety = (l: Lane): number => {
    const q = l.queues[0]!;
    let best = 0;
    for (let i = 1; i < q.length; i++) {
      const run = (e: Entry) => (e.owner === null ? 0 : (l.ownerRunning.get(e.owner) ?? 0));
      if (run(q[i]!) < run(q[best]!)) best = i;
    }
    return best;
  };
  const pump = (l: Lane) => {
    for (;;) {
      const q = l.queues.find((x) => x.length > 0);
      if (!q || !canStart(l, q[0]!.rank)) return;
      if (q === l.queues[0]) q.splice(nextSafety(l), 1)[0]!.start();
      else q.shift()!.start();
    }
  };
  /** The newest waiting exit of the owner holding the most safety places, if that is more than `than`. */
  const hog = (l: Lane, than: number): { l: Lane; e: Entry } | null => {
    let top: { owner: string; n: number } | null = null;
    for (const e of l.queues[0]!) {
      if (e.owner === null) continue;
      const n = held(l, e.owner);
      if (!top || n > top.n) top = { owner: e.owner, n };
    }
    if (!top || top.n <= than) return null;
    const e = l.queues[0]!.filter((x) => x.owner === top!.owner).at(-1);
    return e ? { l, e } : null;
  };
  /** The newest waiting entry of the lowest priority below `rank`, in one lane or in all of them. */
  const victim = (rank: number, within: Lane[]): { l: Lane; e: Entry } | null => {
    for (let r = 2; r > rank; r--) {
      let best: { l: Lane; e: Entry } | null = null;
      for (const l of within) {
        const e = l.queues[r]!.at(-1);
        if (e && (!best || e.seq > best.e.seq)) best = { l, e };
      }
      if (best) return best;
    }
    return null;
  };
  const evict = (v: { l: Lane; e: Entry }, why: string) => {
    const q = v.l.queues[v.e.rank]!;
    q.splice(q.indexOf(v.e), 1);
    if (v.e.rank > 0) openTotal--;
    v.e.refuse(refused(v.l.key, why));
  };
  return {
    order,
    pending: () => [...lanes.values()].reduce((n, l) => n + waitingIn(l), 0),
    openJobs: () => openTotal,
    run<T>(priority: Priority, fn: () => Promise<T>, key = "default", ownerOf?: string): Promise<T> {
      const l = laneOf(key);
      const rank = RANK[priority];
      const owner = ownerOf ? ownerOf.toLowerCase() : null;
      // one owner's exits on one key are bounded, so a flood from one wallet waits behind its own places only
      if (rank === 0 && owner !== null && held(l, owner) >= perOwner) return Promise.reject(refused(key, "this wallet already has the most exits waiting for venue budget"));
      const startsNow = canStart(l, rank) && l.queues.slice(0, rank + 1).every((q) => q.length === 0);
      // one key's wait line: a higher-priority job takes the place of the newest lowest-priority waiting job; an exit
      // with no opening job to displace takes the place of the newest exit of the owner holding the most places
      if (!startsNow && waitingIn(l) >= maxQueued) {
        const v = victim(rank, [l]) ?? (rank === 0 ? hog(l, owner === null ? 1 : held(l, owner) + 1) : null);
        if (!v) return Promise.reject(refused(key, "too many submits waiting for venue budget"));
        evict(v, "too many submits waiting for venue budget");
      }
      // opening jobs across every key: a pro job takes the place of the newest waiting free job
      if (rank > 0 && openTotal >= maxOpen) {
        const v = victim(rank, [...lanes.values()]);
        if (!v) return Promise.reject(refused(key, "the relay is at its limit of open submits"));
        evict(v, "the relay is at its limit of open submits");
      }
      if (rank > 0) openTotal++;
      return new Promise<T>((resolve, reject) => {
        l.queues[rank]!.push({
          seq: ++seq,
          rank,
          owner,
          refuse: reject,
          start: () => {
            l.running++;
            if (rank > 0) l.openRunning++;
            if (rank === 0 && owner !== null) l.ownerRunning.set(owner, (l.ownerRunning.get(owner) ?? 0) + 1);
            order.push(priority);
            let p: Promise<T>;
            try {
              p = fn();
            } catch (e) {
              p = Promise.reject(e);
            }
            p.then(resolve, reject).finally(() => {
              l.running--;
              if (rank === 0 && owner !== null) {
                const n = (l.ownerRunning.get(owner) ?? 1) - 1;
                if (n > 0) l.ownerRunning.set(owner, n);
                else l.ownerRunning.delete(owner);
              }
              if (rank > 0) {
                l.openRunning--;
                openTotal--;
              }
              pump(l);
            });
          },
        });
        pump(l);
      });
    },
  };
}
