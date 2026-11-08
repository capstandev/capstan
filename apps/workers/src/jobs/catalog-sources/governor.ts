// The governor the catalog sources read through: the host's shared Redis governor under the host's one egress label
// (security r2 D2-ADP-06), so the nightly catalog reads count against the same venue budget as every other service on
// this IP. Without REDIS_URL (tests, a laptop) an in-process one.
import { createRedis, type Redis } from "@capstan/core";
import { createGovernor, createMemoryGovernor, egressIdOf, type Governor } from "@capstan/venue-client";

let shared: { redis: Redis | null; gov: Governor } | null = null;

export function catalogGovernor(env: Record<string, string | undefined> = process.env): Governor {
  if (shared) return shared.gov;
  const redis = env.REDIS_URL ? createRedis(env.REDIS_URL, { lazyConnect: true }) : null;
  shared = { redis, gov: redis ? createGovernor(redis, egressIdOf(env)) : createMemoryGovernor(egressIdOf(env)) };
  return shared.gov;
}
