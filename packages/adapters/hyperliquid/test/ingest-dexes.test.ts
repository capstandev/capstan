// Ingest poll errors: a configured dex the network does not list (testnet has no io or para) is skipped once at start
// instead of failing every poll, and a real failure names the dex and the endpoint.
import { describe, expect, test } from "bun:test";
import { memoryMarketDataCache } from "@capstan/core";
import type { VenueWs } from "@capstan/venue-client";
import { createHlIngest, createHlReader } from "../src";
import { CFG, fixtureHttp, fx } from "./helpers";

const stubWs = (): VenueWs => ({ subscribe: () => () => undefined, close: () => undefined, stats: () => ({ connections: 0, opened: 0, subscriptions: 0, openedAt: [] }) });
/** Testnet-like: perpDexs without io and para; dex-scoped reads for an unlisted dex answer HTTP 500 with a null body. */
const unlisted = new Set(["io", "para"]);
const testnetLike = (b: Record<string, any>) => {
  if (b.type === "perpDexs") return fx<any[]>("perpDexs").filter((d) => !d || !unlisted.has(d.name));
  if (b.dex && unlisted.has(b.dex)) return null;
  return undefined;
};

function logger() {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => void lines.push({ level, msg, fields });
  return { lines, log: { info: at("info"), warn: at("warn"), error: at("error") } };
}

describe("ingest", () => {
  test("unlisted-dex-skipped", async () => {
    const { lines, log } = logger();
    const cache = memoryMarketDataCache();
    const reader = createHlReader(CFG, fixtureHttp(testnetLike), cache);
    const ingest = createHlIngest({ reader, cache, ws: stubWs(), log, dexes: [null, "xyz", "io", "para"] });
    const started = await ingest.start();
    expect(started.skippedDexes).toEqual(["io", "para"]);
    const warn = lines.find((l) => l.level === "warn" && l.msg.includes("not listed"));
    expect(warn?.fields).toMatchObject({ dexes: ["io", "para"] });
    for (let i = 0; i < 3; i++) {
      const r = await ingest.pollOnce();
      expect(r.errors).toEqual([]);
      expect(r.dexes).toBe(2);
      expect(r.marks).toBeGreaterThan(0);
    }
    // warned once, not on every poll
    expect(lines.filter((l) => l.msg.includes("not listed")).length).toBe(1);
    ingest.stop();
  });

  test("error-names-dex-and-endpoint", async () => {
    let fail = false;
    const cache = memoryMarketDataCache();
    const reader = createHlReader(
      CFG,
      fixtureHttp((b) => {
        if (fail && b.type === "metaAndAssetCtxs" && b.dex === "xyz") throw new Error("hyperliquid: HTTP 500");
        return undefined;
      }),
      cache,
    );
    const ingest = createHlIngest({ reader, cache, ws: stubWs(), dexes: [null, "xyz"] });
    await ingest.start();
    fail = true;
    const r = await ingest.pollOnce();
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain("dex xyz");
    expect(r.errors[0]).toContain("metaAndAssetCtxs");
    expect(r.errors[0]).toContain("HTTP 500");
    ingest.stop();
  });
});
