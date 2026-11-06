// Relay lanes (spec 9, 14): the free lane takes at most RELAY_FREE_ORDERS_PER_MIN orders per minute per wallet AND per
// client IP bucket (IPv4 /32, IPv6 /64); the pro lane takes its tier's per-wallet rate. Any wallet above BOT_CAP orders
// per minute is pushed to direct mode, whatever its lane (spec 4.1 shared relay IP gotcha). Cancels and reduce-only
// close-alls are safety traffic: never counted, never refused here. One sliding 60 s window, atomic in Redis.
// Redis down: the free lane refuses (fail closed); the pro lane falls back to an in-process window.
import type { Redis } from "@capstan/core";
import type { LaneDecision, LaneLimiter } from "./types";

export const WINDOW_MS = 60_000;
export const BOT_CAP_PER_MIN = 20;
export const DIRECT_MODE_HINT = "This wallet is over the relay limit. Use direct mode (the SDK posts to the venue itself) for automated trading.";

interface Check {
  key: string;
  limit: number;
  reason: NonNullable<LaneDecision["reason"]>;
}

function checksFor(o: Parameters<LaneLimiter["take"]>[0]): Check[] {
  const w = o.wallet.toLowerCase();
  const out: Check[] = [{ key: `relay:bot:${w}`, limit: BOT_CAP_PER_MIN, reason: "bot_cap" }];
  if (o.lane === "free") {
    out.push({ key: `relay:free:w:${w}`, limit: o.perMin, reason: "free_wallet" });
    out.push({ key: `relay:free:ip:${o.ipBucket}`, limit: o.perMin, reason: "free_ip" });
  } else {
    out.push({ key: `relay:pro:w:${w}`, limit: o.perMin, reason: "free_wallet" });
  }
  return out;
}

export function memoryLaneLimiter(): LaneLimiter & { reset(): void } {
  const hits = new Map<string, number[]>();
  return {
    async take(o) {
      if (o.kind !== "order") return { ok: true, lane: o.lane };
      const checks = checksFor(o);
      const live = (k: string) => (hits.get(k) ?? []).filter((t) => t > o.nowMs - WINDOW_MS);
      for (const c of checks) if (live(c.key).length >= c.limit) return { ok: false, lane: o.lane, reason: c.reason };
      for (const c of checks) hits.set(c.key, [...live(c.key), o.nowMs]);
      return { ok: true, lane: o.lane };
    },
    reset: () => hits.clear(),
  };
}

// KEYS: the windows to check; ARGV: now, window, member, then one limit per key. Returns 0 (taken) or the 1-based
// index of the first full window. Nothing is recorded unless every window has room.
const TAKE_LUA = `
local now = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
for i, k in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', k, '-inf', now - win)
  if redis.call('ZCARD', k) >= tonumber(ARGV[3 + i]) then return i end
end
for i, k in ipairs(KEYS) do
  redis.call('ZADD', k, now, ARGV[3])
  redis.call('PEXPIRE', k, win * 2)
end
return 0
`;

export function redisLaneLimiter(redis: Redis): LaneLimiter {
  const local = memoryLaneLimiter();
  let n = 0;
  return {
    async take(o) {
      if (o.kind !== "order") return { ok: true, lane: o.lane };
      const checks = checksFor(o);
      try {
        const member = `${o.nowMs}:${process.pid}:${++n}:${Math.random().toString(36).slice(2, 8)}`;
        const r = Number(await redis.eval(TAKE_LUA, checks.length, ...checks.map((c) => c.key), String(o.nowMs), String(WINDOW_MS), member, ...checks.map((c) => String(c.limit))));
        if (r === 0) return { ok: true, lane: o.lane };
        return { ok: false, lane: o.lane, reason: checks[r - 1]!.reason };
      } catch {
        if (o.lane === "free") return { ok: false, lane: o.lane, reason: "unavailable" };
        return local.take(o);
      }
    },
  };
}
