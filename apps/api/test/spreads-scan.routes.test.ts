// R9 (todo 20): GET /v1/spreads/scan is x402 at $0.02. The answer (cache or live) carries the exact labels and passes
// the banned-word scan; minHours keeps rows that break even within that many hours.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scan, type ScanRow } from "@capstan/spreads";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { createSpreadScanRoutes, type SpreadScanRouteDeps } from "../src/routes/spreads-scan.routes";
import { REQ, setup } from "../../../packages/spreads/test/scan/helpers";

const banned = readFileSync(join(import.meta.dir, "../../../ops/ci/banned-words.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => new RegExp(l, "i"));

describe("spreads scan route", () => {
  test("priced", async () => {
    const [spec] = createSpreadScanRoutes(() => ({ cached: async () => null, live: async () => [] }));
    expect(spec).toMatchObject({ method: "GET", path: "/spreads/scan", auth: "x402", priced: { usd: "0.02" } });
    const { app, routes } = await createApp();
    expect(routes.find((r) => r.path === "/spreads/scan")).toMatchObject({ auth: "x402", file: "spreads-scan.routes.ts" });
    expect((await app.request("/v1/spreads/scan")).status).toBe(401); // no payment verifier: deny by default

    // the handler: live rows, then cached rows; labels exact; nothing banned in the output
    const s = setup();
    const live = await scan(REQ, s.deps);
    let cache: { rows: ScanRow[]; asOf: string } | null = null;
    const deps: SpreadScanRouteDeps = { cached: async () => cache, live: (req) => scan({ ...req, ...REQ }, s.deps), now: () => s.deps.now().getTime() };
    const h = new Hono();
    for (const r of createSpreadScanRoutes(() => deps)) h.on(r.method, `/v1${r.path}`, (c) => r.handler(c));
    const res = await h.request("/v1/spreads/scan?asset=CR:ETH");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { rows: ScanRow[]; riskLabel: string; observedNote: string; source: string };
    expect(j.source).toBe("live");
    expect(j.riskLabel).toBe("At-risk. Legging risk is yours.");
    expect(j.observedNote).toBe("Observed, changes hourly.");
    expect(j.rows.length).toBe(live.length);
    for (const re of banned) expect(JSON.stringify(j)).not.toMatch(re);
    cache = { rows: live, asOf: "2026-11-01T12:00:00.000Z" };
    const fromCache = (await (await h.request("/v1/spreads/scan")).json()) as { source: string; rows: ScanRow[] };
    expect(fromCache.source).toBe("cache");
    const cut = Math.min(...live.map((r) => r.breakevenHours ?? Number.POSITIVE_INFINITY));
    const filtered = (await (await h.request(`/v1/spreads/scan?minHours=${cut}`)).json()) as { rows: ScanRow[] };
    expect(filtered.rows.length).toBeGreaterThan(0);
    expect(filtered.rows.every((r) => r.breakevenHours !== null && r.breakevenHours <= cut)).toBe(true);
    expect((await h.request("/v1/spreads/scan?asset=ETH")).status).toBe(400);
  });
});
