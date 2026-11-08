// Venue read lanes by caller (security r2 D2-ADP-05, review-r1:7 F5). Every adapter read used to run in the free
// governor lane with no deadline, so one IP at the public read limit could hold a venue budget and stall builds,
// nonce seeding and kill-path reads. A caller now names its lane for everything it does inside withVenueLane: safety
// for revocation, cancel and close-all reads, pro for order builds; anything else stays free (public reads). Every
// acquire has a deadline and fails closed with VENUE_RATE_LIMITED when it passes.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Priority } from "./budgets";

export interface VenueLane {
  priority: Priority;
  /** Longest wait for venue budget, per request. */
  deadlineMs?: number;
}

/**
 * Budget waits per lane when the caller names no deadline: safety and pro use the relay's submit deadlines; free
 * (background and public reads) gets two minutes, longer than any one budget window, so it never waits without end.
 */
export const LANE_DEADLINE_MS: Record<Priority, number> = { safety: 30_000, pro: 10_000, free: 120_000 };

const als = new AsyncLocalStorage<VenueLane>();

/** Run `fn` with every venue request inside it governed in `lane`. */
export function withVenueLane<T>(lane: VenueLane | Priority, fn: () => T): T {
  return als.run(typeof lane === "string" ? { priority: lane } : lane, fn);
}

export function currentVenueLane(): VenueLane | undefined {
  return als.getStore();
}
