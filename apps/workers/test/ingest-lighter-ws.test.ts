// ingest-lighter stream errors: the ingest reads the read-only stream (the full stream refuses a restricted
// jurisdiction at the upgrade with HTTP 400, code 20558), and a socket error is logged with its real text and status,
// never "[object ErrorEvent]".
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createLighterIngest, LIGHTER_CONFIGS, lighterReaderFor, type LighterConfig } from "@capstan/adapter-lighter";
import { memoryMarketDataCache, type JobDeps } from "@capstan/core";
import type { MarketEvent } from "@capstan/schema";
import { createMemoryGovernor, fakeVenueServer, loadFixtureRecord } from "@capstan/venue-client";
import { runIngestTick, stopIngest } from "../src/jobs/ingest-lighter.job";

const FX = join(import.meta.dir, "../../../packages/adapters/lighter/test/fixtures");

/** A Lighter-like stream host: /stream refuses the upgrade like a restricted region; ?readonly=true is served. */
function streamHost() {
  let refused = 0;
  const server = Bun.serve<{ ro: boolean }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const u = new URL(req.url);
      if (u.searchParams.get("readonly") !== "true") {
        refused++;
        return new Response(JSON.stringify({ code: 20558, message: "You are accessing Lighter from a restricted jurisdiction." }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return srv.upgrade(req, { data: { ro: true } }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "connected" }));
      },
      message(ws, raw) {
        const m = JSON.parse(String(raw)) as { type: string; channel: string };
        if (m.type === "subscribe" && m.channel === "market_stats/all") ws.send(JSON.stringify({ channel: "market_stats:all", type: "update/market_stats", market_stats: { "0": { market_id: 0, mark_price: "3000.5", index_price: "3000.1" } } }));
      },
    },
  });
  const base = `ws://127.0.0.1:${server.port}/stream`;
  return { base, refused: () => refused, stop: () => server.stop(true) };
}

const host = streamHost();
afterAll(() => host.stop());

const cfgAt = (base: string): Readonly<LighterConfig> => ({ ...LIGHTER_CONFIGS.mainnet, ws: base, readonlyWs: `${base}?readonly=true` });

const waitFor = async (f: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await Bun.sleep(20);
  }
};

describe("ingest-lighter ws", () => {
  test("reads-the-readonly-stream", async () => {
    const errors: unknown[] = [];
    const events: MarketEvent[] = [];
    const ing = createLighterIngest(cfgAt(host.base), { onError: (e) => errors.push(e) });
    const un = ing.start([{ id: "lighter-mainnet:ETH", index: 0, capPerHour: null }], (e) => events.push(e));
    try {
      await waitFor(() => events.some((e) => e.kind === "mark"));
      expect(events.find((e) => e.kind === "mark")).toMatchObject({ marketId: "lighter-mainnet:ETH", mark: "3000.5" });
      expect(errors).toEqual([]);
      expect(host.refused()).toBe(0);
      // every config carries a read-only stream URL
      for (const c of Object.values(LIGHTER_CONFIGS)) expect(c.readonlyWs).toBe(`${c.ws}?readonly=true`);
    } finally {
      un();
      ing.close();
    }
  });

  test("ws-error-logs-real-text", async () => {
    // a config whose read-only URL is refused too: the job's log line carries the runtime text and the HTTP status
    const lines: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log = { info: () => undefined, warn: (msg: string, fields?: Record<string, unknown>) => void lines.push({ msg, fields }), error: () => undefined, debug: () => undefined, child: () => log } as unknown as JobDeps["log"];
    const cache = memoryMarketDataCache();
    const deps: JobDeps = { db: null, redis: null, cache, log, now: () => new Date() };
    const bad: Readonly<LighterConfig> = { ...cfgAt(host.base), readonlyWs: host.base };
    const serve = (n: string) => {
      const r = loadFixtureRecord<unknown>("lighter-304", n, FX);
      return new Response(JSON.stringify(r.response), { status: r.status, headers: { "content-type": "application/json" } });
    };
    const rest = fakeVenueServer({ "GET /api/v1/orderBooks": () => serve("orderBooks"), "GET /api/v1/orderBookDetails": () => serve("orderBookDetails") });
    const r = await runIngestTick(deps, { configs: [bad], reader: (cfg) => lighterReaderFor(cfg, createMemoryGovernor("t"), cache, { rest: rest.url }) }, null);
    try {
      await waitFor(() => lines.some((l) => l.msg === "lighter ws error"));
      const l = lines.find((x) => x.msg === "lighter ws error")!;
      expect(String(l.fields?.error)).not.toContain("[object");
      expect(String(l.fields?.error)).toContain("400");
      expect(l.fields?.httpStatus).toBe(400);
      expect(l.fields?.venue).toBe("lighter-mainnet");
    } finally {
      stopIngest(r.state);
      rest.stop();
    }
  });
});
