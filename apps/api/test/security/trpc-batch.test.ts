// r1:3 F5: tRPC batching had no size limit, so one GET /trpc/a,a,a,...?batch=1 fanned out to thousands of internal
// route calls. A batch now holds at most TRPC_MAX_BATCH procedures; a larger one answers 400 before any call runs.
import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { TRPC_MAX_BATCH } from "../../src/trpc";

const batch = (n: number) => `/trpc/${Array.from({ length: n }, () => "ping").join(",")}?batch=1&input=${encodeURIComponent("{}")}`;

describe("tRPC batch limit (r1:3 F5)", () => {
  test(`a batch of ${10} answers 200 and a batch of 11 answers 400`, async () => {
    expect(TRPC_MAX_BATCH).toBe(10);
    const { app } = await createApp();
    const ok = await app.request(batch(10));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as unknown[]).length).toBe(10);
    expect((await app.request(batch(11))).status).toBe(400);
    expect((await app.request(batch(2000))).status).toBe(400);
  });
});
