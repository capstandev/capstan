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

/**
 * Longest venue budget wait inside one HTTP request (G4-01). A request used to wait on the governor up to its lane
 * deadline (pro 10 s, safety 30 s, free 120 s) with no byte sent, and the server closed the socket. Inside
 * withRequestDeadline every budget wait is cut to what is left of this, so the caller gets VENUE_RATE_LIMITED (429
 * with Retry-After) fast and can retry. Kept under 10 s so a client with a 10 s timeout still reads the answer.
 */
export const REQUEST_VENUE_WAIT_MS = 8_000;

/** One request's venue budget: when its waits must end, and the longest wait a refusal inside it asked for. */
export interface RequestVenueWait {
  until: number;
  retryAfterMs?: number;
}

const deadlineAls = new AsyncLocalStorage<RequestVenueWait>();

/** Run `fn` (one HTTP request) with all venue budget waits inside it ending by `w.until`. */
export function withRequestDeadline<T>(w: RequestVenueWait, fn: () => T): T {
  return deadlineAls.run(w, fn);
}

/** Milliseconds left of the current request's budget wait, or undefined outside a request. */
export function requestWaitLeftMs(): number | undefined {
  const w = deadlineAls.getStore();
  return w === undefined ? undefined : Math.max(0, w.until - Date.now());
}

/** A budget refusal inside the current request: keep the longest retry hint for the answer's Retry-After. */
export function noteVenueRefusal(retryAfterMs: number): void {
  const w = deadlineAls.getStore();
  if (w) w.retryAfterMs = Math.max(w.retryAfterMs ?? 0, retryAfterMs);
}
