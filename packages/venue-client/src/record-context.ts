// Recording context for recordFixture: while a recorder is active, every venue request is checked first (reads only)
// and its exchange captured.
import { AsyncLocalStorage } from "node:async_hooks";
import type { VenueKey } from "./budgets";
import type { Method, RawResponse } from "./http";

export interface Recorder {
  check(venue: VenueKey, method: Method, path: string): void;
  capture(venue: VenueKey, method: Method, url: string, body: unknown, raw: RawResponse): void;
}

const als = new AsyncLocalStorage<Recorder>();

export function currentRecorder(): Recorder | undefined {
  return als.getStore();
}

export function withRecorder<T>(r: Recorder, fn: () => Promise<T>): Promise<T> {
  return als.run(r, fn);
}
