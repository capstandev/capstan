// Shared test helpers: a fake clock and the governor stores to run each test against (Redis only with REDIS_URL).
import { createRedis } from "@capstan/core";
import type { Redis } from "ioredis";
import { createGovernorWithStore, memoryGovernorStore, redisGovernorStore, type Governor, type GovernorStore } from "../src/governor";

export function fakeClock(start = 1_800_000_010_000) {
  const c = {
    t: start,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += ms;
    },
  };
  return c;
}

export const REDIS_URL = process.env.REDIS_URL;
const clients: Redis[] = [];
export function redisClient(): Redis {
  const r = createRedis(REDIS_URL!);
  clients.push(r);
  return r;
}
export async function closeClients(): Promise<void> {
  await Promise.all(clients.splice(0).map((c) => c.quit()));
}

let seq = 0;
export function uniqueEgress(tag: string): string {
  return `test-${tag}-${process.pid}-${Date.now()}-${seq++}`;
}

export type StoreKind = "memory" | "redis";
export const STORE_KINDS: StoreKind[] = REDIS_URL ? ["memory", "redis"] : ["memory"];

export function makeStore(kind: StoreKind): GovernorStore {
  return kind === "memory" ? memoryGovernorStore() : redisGovernorStore(redisClient());
}

export function makeGov(kind: StoreKind, clock: ReturnType<typeof fakeClock>, egress = uniqueEgress(kind), store = makeStore(kind)): Governor {
  return createGovernorWithStore(store, egress, { now: clock.now, sleep: clock.sleep });
}
