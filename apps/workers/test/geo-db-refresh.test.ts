// geo-db-refresh: weekly check, monthly file. Uses the current month's DB-IP file once published, keeps the old one
// on any failure, swaps atomically and logs the sha256. The fetch is faked with real rows from the 2026-11 sample.
import { afterAll, describe, expect, test } from "bun:test";
import { logger, type JobDeps } from "@capstan/core";
import { dbIpUrl, fileGeo, GEO_FILE, readGeoMeta } from "@capstan/eligibility";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { job, runGeoRefresh } from "../src/jobs/geo-db-refresh.job";

const SAMPLE = readFileSync(join(import.meta.dir, "../../../packages/eligibility/test/fixtures/dbip-country-lite-2026-11.sample.csv"));
const gz = (b: Uint8Array) => Bun.gzipSync(new Uint8Array(b));
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function harness(files: Record<string, Uint8Array | number>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    const f = files[String(url)];
    if (f === undefined) return new Response("no", { status: 404 });
    if (typeof f === "number") return new Response("err", { status: f });
    return new Response(new Uint8Array(f), { status: 200, headers: { "content-length": String(f.byteLength) } });
  }) as unknown as typeof fetch;
  const events: unknown[] = [];
  const logs: string[] = [];
  const deps = (iso: string): JobDeps => ({ db: null, redis: null, cache: null, log: logger("t", { sink: (l) => logs.push(l) }), now: () => new Date(iso), publish: async (_ch, p) => void events.push(p) });
  const dir = mkdtempSync(join(tmpdir(), "capstan-geo-job-"));
  dirs.push(dir);
  return { calls, events, logs, deps, dir, fetchImpl };
}

describe("geo-db-refresh job", () => {
  test("schedule: weekly, Mondays 03:30 UTC", () => {
    expect(job).toMatchObject({ name: "geo-db-refresh", schedule: { pattern: "30 3 * * 1" }, concurrency: 1 });
    expect(dbIpUrl("2026-11")).toBe("https://download.db-ip.com/free/dbip-country-lite-2026-11.csv.gz");
  });

  test("first run, weekly no-op, next month not yet published, then published", async () => {
    const nov = gz(SAMPLE);
    const dec = gz(new Uint8Array(Buffer.concat([SAMPLE, Buffer.from("223.255.255.0,223.255.255.255,AU\n")])));
    const h = harness({ [dbIpUrl("2026-11")]: nov });
    const o = { fetchImpl: h.fetchImpl, dir: h.dir, minRanges: 100 };
    const r1 = await runGeoRefresh(h.deps("2026-11-09T03:30:00Z"), o);
    expect(r1).toEqual({ status: "updated", month: "2026-11", sha256: createHash("sha256").update(nov).digest("hex") });
    expect(readGeoMeta(h.dir)).toMatchObject({ month: "2026-11", sha256: r1.sha256, v4Ranges: 246 });
    // the full sha256 sits in the meta file; the log line carries the logger's shortened form (no full hash in logs)
    expect(h.logs.join("\n")).toContain(`${r1.sha256!.slice(0, 4)}..${r1.sha256!.slice(-4)}`);
    const g = fileGeo(join(h.dir, GEO_FILE));
    expect(g.country("1.178.10.1")).toBe("DE");

    // a week later: nothing fetched
    const n = h.calls.length;
    expect((await runGeoRefresh(h.deps("2026-11-16T03:30:00Z"), o)).status).toBe("current");
    expect(h.calls.length).toBe(n);

    // 1 December, early: the December file is not up yet, November stays
    const r3 = await runGeoRefresh(h.deps("2026-12-01T00:10:00Z"), o);
    expect(r3).toMatchObject({ status: "not_published", month: "2026-11" });
    expect(h.calls.at(-1)).toBe(dbIpUrl("2026-12"));

    // once December is published it is swapped in, with no temp file left behind
    const h2 = { ...o, fetchImpl: harness({ [dbIpUrl("2026-12")]: dec }).fetchImpl };
    const r4 = await runGeoRefresh(h.deps("2026-12-07T03:30:00Z"), h2);
    expect(r4).toMatchObject({ status: "updated", month: "2026-12" });
    expect(readdirSync(h.dir).sort()).toEqual(["dbip-country-lite.csv.gz", "dbip-country-lite.meta.json"]);
  });

  test("bad downloads keep the old file and raise an ops event", async () => {
    const h = harness({ [dbIpUrl("2026-11")]: gz(SAMPLE) });
    await runGeoRefresh(h.deps("2026-11-09T03:30:00Z"), { fetchImpl: h.fetchImpl, dir: h.dir, minRanges: 100 });
    const before = readFileSync(join(h.dir, GEO_FILE));
    const bad: [string, Uint8Array | number][] = [
      ["not gzip", new TextEncoder().encode("hello")],
      ["too few rows", gz(new TextEncoder().encode("1.0.0.0,1.0.0.255,AU\n"))],
      ["server error", 500],
      ["too big", new Uint8Array(2048)],
    ];
    for (const [name, body] of bad) {
      const hb = harness({ [dbIpUrl("2026-12")]: body });
      const r = await runGeoRefresh(h.deps("2026-12-07T03:30:00Z"), { fetchImpl: hb.fetchImpl, dir: h.dir, minRanges: 100, ...(name === "too big" ? { maxBytes: 1024 } : {}) });
      expect(r.status, name).toBe("failed");
      expect(r.month).toBe("2026-11");
      expect(readFileSync(join(h.dir, GEO_FILE)).equals(before), name).toBe(true);
    }
    expect(h.events).toHaveLength(4);
    expect(h.events[0]).toMatchObject({ kind: "geo.refresh_failed" });
  });

  test("an empty folder with nothing published stays empty (writes fail closed)", async () => {
    const h = harness({});
    const r = await runGeoRefresh(h.deps("2026-11-02T00:00:00Z"), { fetchImpl: h.fetchImpl, dir: h.dir });
    expect(r).toEqual({ status: "not_published", month: null, sha256: null });
    expect(existsSync(join(h.dir, GEO_FILE))).toBe(false);
    expect(h.calls).toEqual([dbIpUrl("2026-11"), dbIpUrl("2026-10")]);
    expect(fileGeo(join(h.dir, GEO_FILE)).country("1.178.10.1")).toBeNull();
  });

  test.skipIf(process.env.CAPSTAN_LIVE !== "1")("live: the current DB-IP Lite file is downloadable without an account", async () => {
    const h = harness({});
    const r = await runGeoRefresh(h.deps(new Date().toISOString()), { dir: h.dir });
    expect(["updated"]).toContain(r.status);
    const g = fileGeo(join(h.dir, GEO_FILE));
    expect(g.country("1.0.1.1")).toBe("CN");
  });
});
