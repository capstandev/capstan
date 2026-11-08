// Relay lanes (spec 9, 14): the free lane takes at most RELAY_FREE_ORDERS_PER_MIN orders per minute per wallet AND per
// client IP bucket (IPv4 /32, IPv6 /64); the pro lane takes its tier's per-wallet rate. Any wallet above BOT_CAP orders
// per minute is pushed to direct mode, whatever its lane (spec 4.1 shared relay IP gotcha). Cancels, closes and
// reduce-only orders are exit traffic: they skip the open lanes and the bot cap, but are still counted by their own
// exit lane, EXIT_PER_MIN_WALLET per wallet and EXIT_PER_MIN_IP per IP bucket (security r1 R1-02: uncounted exits let
// one actor fill every submit slot). One sliding 60 s window, atomic in Redis.
// Redis down: the free lane refuses (fail closed); the pro lane and the exit lane fall back to an in-process window
// (an exit is never refused only because Redis is down).
import type { Redis } from "@capstan/core";
import type { VenueId } from "@capstan/schema";
import type { LaneDecision, LaneLimiter } from "./types";

export const WINDOW_MS = 60_000;
export const BOT_CAP_PER_MIN = 20;
/** Exit traffic per minute: well above any honest close pattern (a kill closes one order per market). */
export const EXIT_PER_MIN_WALLET = 60;
export const EXIT_PER_MIN_IP = 120;
/**
 * Exit caps per venue budget (security r2 R2-RELAY-02). Lighter's shared relay budget is 60 requests a minute at one a
 * second (governor 80%, so 48), so one IP bucket may take at most half of it and one wallet a quarter; Hyperliquid
 * and Aster budgets are weight based and far larger, so the defaults above apply.
 */
export const EXIT_CAPS: Partial<Record<VenueId, { wallet: number; ip: number }>> = {
  "lighter-mainnet": { wallet: 12, ip: 24 },
  "lighter-rh": { wallet: 12, ip: 24 },
};
export const DIRECT_MODE_HINT = "This wallet is over the relay limit. Use direct mode (the SDK posts to the venue itself) for automated trading.";

interface Check {
  key: string;
  limit: number;
  reason: NonNullable<LaneDecision["reason"]>;
}

function checksFor(o: Parameters<LaneLimiter["take"]>[0]): Check[] {
  const w = o.wallet.toLowerCase();
  if (o.kind !== "order") {
    const out: Check[] = [
      { key: `relay:exit:w:${w}`, limit: EXIT_PER_MIN_WALLET, reason: "exit_wallet" },
      { key: `relay:exit:ip:${o.ipBucket}`, limit: EXIT_PER_MIN_IP, reason: "exit_ip" },
    ];
    const v = o.venue ? EXIT_CAPS[o.venue] : undefined;
    if (v) {
      out.push({ key: `relay:exit:${o.venue}:w:${w}`, limit: v.wallet, reason: "exit_wallet" });
      out.push({ key: `relay:exit:${o.venue}:ip:${o.ipBucket}`, limit: v.ip, reason: "exit_ip" });
    }
    return out;
  }
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
      const checks = checksFor(o);
      try {
        const member = `${o.nowMs}:${process.pid}:${++n}:${Math.random().toString(36).slice(2, 8)}`;
        const r = Number(await redis.eval(TAKE_LUA, checks.length, ...checks.map((c) => c.key), String(o.nowMs), String(WINDOW_MS), member, ...checks.map((c) => String(c.limit))));
        if (r === 0) return { ok: true, lane: o.lane };
        return { ok: false, lane: o.lane, reason: checks[r - 1]!.reason };
      } catch {
        if (o.lane === "free" && o.kind === "order") return { ok: false, lane: o.lane, reason: "unavailable" };
        return local.take(o);
      }
    },
  };
}
