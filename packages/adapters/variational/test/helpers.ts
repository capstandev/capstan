// Test helpers: recorded live fixtures (test/fixtures), a fake clock and a fetch double for the venue client.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VariationalStats } from "../src/normalize";

export const FIXTURES = join(import.meta.dir, "fixtures");
export function fixture<T>(name: string): T {
  return (JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as { response: T }).response;
}
export const stats = () => fixture<VariationalStats>("stats");
export const rateLimitedBody = () => fixture<{ error: string; message: string; retry_after_seconds: number }>("error_rateLimited");

export function fakeClock(start = 1_800_000_000_000) {
  const c = { t: start, now: () => c.t, sleep: async (ms: number) => void (c.t += ms) };
  return c;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
