// G4-01 (release gate 2026-11-12): a request that waited on the venue budget past Bun's 10 s idle default got its
// socket closed (ECONNRESET at /v1/onboarding/preflight in the fork run). The api now cuts every budget wait inside a
// request to REQUEST_VENUE_WAIT_MS and answers 429 VENUE_RATE_LIMITED with Retry-After. This file runs the api on a
// plain Bun.serve (Bun's default idle timeout) so the old behaviour shows as a closed socket.
import { afterAll, expect, test } from "bun:test";
import { CapstanError } from "@capstan/schema";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";

const gov = createMemoryGovernor(`g4-01-${process.pid}-${Date.now()}`);
// nothing listens here: the read must be refused by the governor before any byte goes out
const hl = venueHttp("hyperliquid", "http://127.0.0.1:9", gov);
let venueCalls = 0;
const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => servers.forEach((s) => s.stop(true)));

test("a venue budget wait past 10 s answers 429 with Retry-After, not a closed socket", async () => {
  // the free lane is full (960 of 1,200 HL weight this minute): the next read would wait about a minute
  await gov.acquire("hyperliquid", 960, { priority: "free" });
  const route = {
    method: "GET" as const,
    path: "/held",
    auth: "public" as const,
    handler: async (c: { json(x: unknown): Response }) => {
      venueCalls++;
      await hl.request("POST", "/info", { json: { type: "meta" }, cost: 20 });
      return c.json({ ok: true });
    },
  };
  // most routes catch a CapstanError and answer it themselves: the Retry-After must be there too
  const caught = {
    ...route,
    path: "/held-caught",
    handler: async (c: { json(x: unknown, s?: number): Response }) => {
      try {
        await hl.request("POST", "/info", { json: { type: "meta" }, cost: 20 });
        return c.json({ ok: true });
      } catch (e) {
        if (e instanceof CapstanError) return c.json(e.toBody(), e.status);
        throw e;
      }
    },
  };
  const { app } = await createApp({ routesDir: mkdtempSync(join(tmpdir(), "capstan-g4-")), extraRoutes: [route as never, caught as never] });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch }); // Bun's default idle timeout (10 s)
  servers.push(server);
  const t0 = Date.now();
  let res: Response | null = null;
  let err: unknown = null;
  try {
    res = await fetch(`http://127.0.0.1:${server.port}/v1/held`, { signal: AbortSignal.timeout(14_000) });
  } catch (e) {
    err = e;
  }
  const ms = Date.now() - t0;
  expect(err ? String((err as { code?: string }).code ?? err) : null).toBeNull();
  expect(res!.status).toBe(429);
  const body = (await res!.json()) as { error: { code: string } };
  expect(body.error.code).toBe("VENUE_RATE_LIMITED");
  expect(Number(res!.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  expect(ms).toBeLessThan(9_000);
  expect(venueCalls).toBe(1);
  const r2 = await fetch(`http://127.0.0.1:${server.port}/v1/held-caught`, { signal: AbortSignal.timeout(14_000) });
  expect(r2.status).toBe(429);
  expect(Number(r2.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
}, 30_000);
