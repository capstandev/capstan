// Venue budget governor: one sliding-window budget per (egress IP, venue), shared by every process on that IP through
// Redis (one atomic Lua script per attempt). Normal lanes ('pro', 'free') stop at 80% of the venue limit; 'safety'
// (cancels, kill-switch reads, close-all) may use the last 20%. 'free' waits while any 'pro' caller is waiting.
// It never rotates or spreads requests across IPs to dodge a limit: `egress` is one value per host.
//
// Window accounting: usage is kept in time slots (windowMs / 60, at least 100 ms). A slot counts while any part of it
// overlaps the window, so the count over any real window is never under-estimated.
// Venue feedback (observe): Aster's x-mbx-used-weight-1m raises the count until the venue's minute resets; a 429 sets a
// cool-off (Retry-After header, or Variational's retry_after_seconds body field, else 2 s); a 418 sets a ban during
// which every acquire throws VENUE_RATE_LIMITED and nothing is sent.
import { CapstanError } from "@capstan/schema";
import type { Redis } from "ioredis";
import { budgetFor, laneCap, type BucketKey, type Priority } from "./budgets";

export interface Lease {
  venue: BucketKey;
  cost: number;
  at: number; // ms, governor clock
  priority: Priority;
}

export interface Usage {
  used: number;
  cap: number;
  pct: number;
  bannedUntil: number | null;
}

export interface Governor {
  acquire(venue: BucketKey, cost: number, opts?: { priority?: Priority; deadlineMs?: number }): Promise<Lease>;
  observe(venue: BucketKey, res: { status: number; headers: Headers; body?: unknown }): void;
  usage(venue: BucketKey): Usage;
  /** Wait until every observe() call has been applied (tests, and before a retry decision). */
  flush(): Promise<void>;
  readonly egress: string;
}

export interface GovernorOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Default cool-off after a 429 with no retry hint. */
  default429Ms?: number;
  /** Default ban after a 418 with no hint (Aster bans run 2 minutes to 3 days). */
  default418Ms?: number;
}

const PRIORITY_CODE: Record<Priority, number> = { safety: 0, pro: 1, free: 2 };
export const DEFAULT_429_MS = 2000;
export const DEFAULT_418_MS = 120_000;

export function slotMsFor(windowMs: number): number {
  return Math.max(100, Math.floor(windowMs / 60));
}

/** Result of one attempt: 0 banned, 1 wait, 2 granted. */
export type Attempt = { code: 0 | 1 | 2; waitMs: number; bannedUntil: number; used: number };

/** Storage for the algorithm. The Redis store runs it in Lua; the memory store runs the same steps in JS. */
export interface GovernorStore {
  attempt(key: string, a: { now: number; cost: number; perWindow: number; windowMs: number; slotMs: number; minIntervalMs: number; priority: number }): Promise<Attempt>;
  setBan(key: string, until: number, ttlMs: number): Promise<void>;
  setCool(key: string, until: number, ttlMs: number): Promise<void>;
  setExternal(key: string, used: number, until: number, ttlMs: number): Promise<void>;
  proWaiting(key: string, delta: 1 | -1): Promise<number>;
  proWaiters(key: string): Promise<number>;
}

// ---------------------------------------------------------------- Lua (Redis store)
// KEYS[1] = key prefix. ARGV: now, cost, perWindow, windowMs, slotMs, minIntervalMs, priority.
const ATTEMPT_LUA = `
local p = KEYS[1]
local now = tonumber(ARGV[1]); local cost = tonumber(ARGV[2]); local per = tonumber(ARGV[3])
local win = tonumber(ARGV[4]); local slot = tonumber(ARGV[5]); local minInt = tonumber(ARGV[6]); local pri = tonumber(ARGV[7])
local ban = tonumber(redis.call('GET', p .. ':ban') or '0')
if now < ban then return {0, ban - now, ban, 0} end
local cool = tonumber(redis.call('GET', p .. ':cool') or '0')
if now < cool then return {1, cool - now, 0, 0} end
local cap = per
if pri ~= 0 then cap = math.floor(per * 0.8) end
local raw = redis.call('HGETALL', p .. ':slots')
local used = 0
local starts = {}
local byStart = {}
for i = 1, #raw, 2 do
  local s = tonumber(raw[i]); local v = tonumber(raw[i + 1])
  if s + slot <= now - win then
    redis.call('HDEL', p .. ':slots', raw[i])
  else
    used = used + v
    table.insert(starts, s)
    byStart[s] = v
  end
end
table.sort(starts)
local eff = used
local extUntil = 0
local ext = redis.call('GET', p .. ':ext')
if ext then
  local sep = string.find(ext, '|', 1, true)
  local eu = tonumber(string.sub(ext, 1, sep - 1)); local et = tonumber(string.sub(ext, sep + 1))
  if now < et and eu > eff then eff = eu; extUntil = et end
end
if eff + cost > cap then
  if extUntil > 0 then return {1, extUntil - now, 0, eff} end
  local remaining = used
  for _, s in ipairs(starts) do
    remaining = remaining - byStart[s]
    if remaining + cost <= cap then
      local w = s + slot + win - now
      if w < 1 then w = 1 end
      return {1, w, 0, used}
    end
  end
  return {1, win, 0, used}
end
local last = tonumber(redis.call('GET', p .. ':last') or '-1')
if minInt > 0 and last >= 0 and now - last < minInt then return {1, last + minInt - now, 0, used} end
local s0 = now - (now % slot)
redis.call('HINCRBY', p .. ':slots', tostring(s0), cost)
redis.call('PEXPIRE', p .. ':slots', win * 2 + slot)
redis.call('SET', p .. ':last', tostring(now), 'PX', win * 2 + minInt + 1000)
return {2, 0, 0, used + cost}
`;

export function redisGovernorStore(redis: Redis): GovernorStore {
  return {
    async attempt(key, a) {
      const r = (await redis.eval(ATTEMPT_LUA, 1, key, a.now, a.cost, a.perWindow, a.windowMs, a.slotMs, a.minIntervalMs, a.priority)) as number[];
      return { code: r[0] as 0 | 1 | 2, waitMs: Number(r[1]), bannedUntil: Number(r[2]), used: Number(r[3]) };
    },
    async setBan(key, until, ttlMs) {
      // never shorten an existing ban
      const cur = Number((await redis.get(`${key}:ban`)) ?? 0);
      if (until > cur) await redis.set(`${key}:ban`, String(until), "PX", Math.max(1, ttlMs));
    },
    async setCool(key, until, ttlMs) {
      const cur = Number((await redis.get(`${key}:cool`)) ?? 0);
      if (until > cur) await redis.set(`${key}:cool`, String(until), "PX", Math.max(1, ttlMs));
    },
    async setExternal(key, used, until, ttlMs) {
      await redis.set(`${key}:ext`, `${used}|${until}`, "PX", Math.max(1, ttlMs));
    },
    async proWaiting(key, delta) {
      const n = await redis.incrby(`${key}:prowait`, delta);
      await redis.pexpire(`${key}:prowait`, 10_000);
      if (n < 0) await redis.set(`${key}:prowait`, "0", "PX", 10_000);
      return Math.max(0, n);
    },
    async proWaiters(key) {
      return Math.max(0, Number((await redis.get(`${key}:prowait`)) ?? 0));
    },
  };
}

// ---------------------------------------------------------------- memory store (same steps in JS)
export function memoryGovernorStore(): GovernorStore {
  type S = { slots: Map<number, number>; ban: number; cool: number; ext: { used: number; until: number } | null; last: number; prowait: number };
  const m = new Map<string, S>();
  const get = (k: string): S => {
    let s = m.get(k);
    if (!s) {
      s = { slots: new Map(), ban: 0, cool: 0, ext: null, last: -1, prowait: 0 };
      m.set(k, s);
    }
    return s;
  };
  return {
    async attempt(key, a) {
      const s = get(key);
      if (a.now < s.ban) return { code: 0, waitMs: s.ban - a.now, bannedUntil: s.ban, used: 0 };
      if (a.now < s.cool) return { code: 1, waitMs: s.cool - a.now, bannedUntil: 0, used: 0 };
      const cap = a.priority !== 0 ? Math.floor(a.perWindow * 0.8) : a.perWindow;
      let used = 0;
      for (const [st, v] of [...s.slots]) {
        if (st + a.slotMs <= a.now - a.windowMs) s.slots.delete(st);
        else used += v;
      }
      const starts = [...s.slots.keys()].sort((x, y) => x - y);
      let eff = used;
      let extUntil = 0;
      if (s.ext && a.now < s.ext.until && s.ext.used > eff) {
        eff = s.ext.used;
        extUntil = s.ext.until;
      }
      if (eff + a.cost > cap) {
        if (extUntil > 0) return { code: 1, waitMs: extUntil - a.now, bannedUntil: 0, used: eff };
        let remaining = used;
        for (const st of starts) {
          remaining -= s.slots.get(st)!;
          if (remaining + a.cost <= cap) return { code: 1, waitMs: Math.max(1, st + a.slotMs + a.windowMs - a.now), bannedUntil: 0, used };
        }
        return { code: 1, waitMs: a.windowMs, bannedUntil: 0, used };
      }
      if (a.minIntervalMs > 0 && s.last >= 0 && a.now - s.last < a.minIntervalMs) return { code: 1, waitMs: s.last + a.minIntervalMs - a.now, bannedUntil: 0, used };
      const s0 = a.now - (a.now % a.slotMs);
      s.slots.set(s0, (s.slots.get(s0) ?? 0) + a.cost);
      s.last = a.now;
      return { code: 2, waitMs: 0, bannedUntil: 0, used: used + a.cost };
    },
    async setBan(key, until) {
      const s = get(key);
      s.ban = Math.max(s.ban, until);
    },
    async setCool(key, until) {
      const s = get(key);
      s.cool = Math.max(s.cool, until);
    },
    async setExternal(key, used, until) {
      get(key).ext = { used, until };
    },
    async proWaiting(key, delta) {
      const s = get(key);
      s.prowait = Math.max(0, s.prowait + delta);
      return s.prowait;
    },
    async proWaiters(key) {
      return get(key).prowait;
    },
  };
}

// ---------------------------------------------------------------- response parsing
function headerNum(h: Headers, name: string): number | null {
  const v = h.get(name);
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Retry hint in ms: Retry-After header (seconds), or a JSON body `retry_after_seconds` (Variational). */
export function retryAfterMs(res: { headers: Headers; body?: unknown }): number | null {
  const h = headerNum(res.headers, "retry-after");
  if (h !== null) return h * 1000;
  const b = res.body as { retry_after_seconds?: unknown } | undefined;
  if (b && typeof b === "object" && typeof b.retry_after_seconds === "number") return b.retry_after_seconds * 1000;
  return null;
}

/** Aster/Binance 418 bodies say "IP banned until <ms>". */
export function bannedUntilFromBody(body: unknown): number | null {
  const text = typeof body === "string" ? body : body && typeof body === "object" ? JSON.stringify(body) : "";
  const m = /banned until (\d{13})/i.exec(text);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- governor
export function createGovernorWithStore(store: GovernorStore, egress: string, opts: GovernorOptions = {}): Governor {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const d429 = opts.default429Ms ?? DEFAULT_429_MS;
  const d418 = opts.default418Ms ?? DEFAULT_418_MS;
  const keyOf = (v: BucketKey) => `gov:${egress}:${v}`;
  const last = new Map<BucketKey, Usage>();
  let pending: Promise<unknown> = Promise.resolve();

  const record = (venue: BucketKey, used: number, bannedUntil: number | null) => {
    const b = budgetFor(venue);
    last.set(venue, { used, cap: b.perWindow, pct: b.perWindow ? (used / b.perWindow) * 100 : 0, bannedUntil });
  };

  return {
    egress,
    async acquire(venue, cost, o = {}) {
      const priority = o.priority ?? "free";
      const b = budgetFor(venue);
      if (!Number.isInteger(cost) || cost < 0) throw new Error("governor: cost must be a non-negative integer");
      if (cost > laneCap(b.perWindow, priority)) throw new CapstanError("VENUE_RATE_LIMITED", `cost ${cost} exceeds the ${priority} budget for ${venue}`);
      await pending;
      const key = keyOf(venue);
      const start = now();
      const deadline = o.deadlineMs !== undefined ? start + o.deadlineMs : Number.POSITIVE_INFINITY;
      let registered = false;
      try {
        for (;;) {
          const t = now();
          if (priority === "free" && (await store.proWaiters(key)) > 0) {
            if (t + 25 > deadline) throw new CapstanError("VENUE_RATE_LIMITED", `${venue}: waiting behind pro traffic`, { retryAfterMs: 1_000 });
            await sleep(25);
            continue;
          }
          const r = await store.attempt(key, {
            now: t,
            cost,
            perWindow: b.perWindow,
            windowMs: b.windowMs,
            slotMs: slotMsFor(b.windowMs),
            minIntervalMs: b.minIntervalMs ?? 0,
            priority: PRIORITY_CODE[priority],
          });
          if (r.code === 2) {
            record(venue, r.used, null);
            return { venue, cost, at: t, priority };
          }
          if (r.code === 0) {
            record(venue, r.used, r.bannedUntil);
            throw new CapstanError("VENUE_RATE_LIMITED", `${venue} is banned for this IP until ${new Date(r.bannedUntil).toISOString()}`, { retryAfterMs: Math.max(0, r.bannedUntil - t) });
          }
          record(venue, r.used, null);
          if (t + r.waitMs > deadline) throw new CapstanError("VENUE_RATE_LIMITED", `${venue}: budget wait ${r.waitMs} ms passes the deadline`, { retryAfterMs: r.waitMs });
          // pro and safety waiters both hold free traffic back (security r2 D2-ADP-05: a safety read used not to
          // register, so a flood of free reads kept taking the slot it waited for)
          if (priority !== "free" && !registered) {
            registered = true;
            await store.proWaiting(key, 1);
          }
          await sleep(Math.max(1, r.waitMs));
        }
      } finally {
        if (registered) await store.proWaiting(key, -1);
      }
    },
    observe(venue, res) {
      const key = keyOf(venue);
      const t = now();
      const jobs: Promise<unknown>[] = [];
      const used = headerNum(res.headers, "x-mbx-used-weight-1m");
      if (used !== null) {
        // Binance-style counters reset at the start of each UTC minute
        const until = t - (t % 60_000) + 60_000;
        jobs.push(store.setExternal(key, used, until, until - t));
      }
      if (res.status === 418) {
        const until = bannedUntilFromBody(res.body) ?? t + (retryAfterMs(res) ?? d418);
        jobs.push(store.setBan(key, until, until - t));
        record(venue, last.get(venue)?.used ?? 0, until);
      } else if (res.status === 429) {
        const until = t + (retryAfterMs(res) ?? d429);
        jobs.push(store.setCool(key, until, until - t));
      }
      pending = pending.then(() => Promise.all(jobs)).catch(() => undefined);
    },
    usage(venue) {
      const b = budgetFor(venue);
      return last.get(venue) ?? { used: 0, cap: b.perWindow, pct: 0, bannedUntil: null };
    },
    async flush() {
      await pending;
    },
  };
}

/** Governor shared through Redis by every process on this egress IP. */
export function createGovernor(redis: Redis, egress: string, opts?: GovernorOptions): Governor {
  return createGovernorWithStore(redisGovernorStore(redis), egress, opts);
}

/** In-process governor (tests and single-process tools). */
export function createMemoryGovernor(egress: string, opts?: GovernorOptions): Governor {
  return createGovernorWithStore(memoryGovernorStore(), egress, opts);
}

/** A Lighter submit takes the per-IP config bucket (shared with reads) and the per-L1 bucket, in that order. */
export async function acquireLighterSubmit(
  gov: Governor,
  config: "lighter-304" | "lighter-466324" | "lighter-300",
  l1: string,
  opts?: { priority?: Priority; deadlineMs?: number },
): Promise<[Lease, Lease]> {
  const ip = await gov.acquire(config, 1, opts);
  const perL1 = await gov.acquire(`${config}:l1:${l1.toLowerCase()}`, 1, opts);
  return [ip, perL1];
}
