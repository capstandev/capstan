// The shared /health helper (ops/uptime): version source, cached and capped dependency probe, never-cached answer.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healthBody, healthProbe, healthResponse, NO_STORE_HEADERS, releaseVersion } from "../src/health";

describe("releaseVersion", () => {
  test("CAPSTAN_VERSION wins, then the release directory sha, then dev", () => {
    const root = mkdtempSync(join(tmpdir(), "capstan-health-"));
    try {
      const rel = join(root, "releases", "4d3f5e7aa11b22c33d44e55f66a77b88c99d00e1");
      mkdirSync(rel, { recursive: true });
      symlinkSync(rel, join(root, "current"));
      expect(releaseVersion({ CAPSTAN_VERSION: " v1.2.3 " }, join(root, "current"))).toBe("v1.2.3");
      expect(releaseVersion({}, join(root, "current"))).toBe("4d3f5e7aa11b");
      expect(releaseVersion({}, root)).toBe("dev");
      expect(releaseVersion({}, join(root, "gone"))).toBe("dev");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("healthProbe", () => {
  test("names the failing checks: a throw, a false, and one slower than the cap", async () => {
    const p = healthProbe(
      { good: async () => true, bad: async () => { throw new Error("down"); }, no: async () => false, slow: () => new Promise((r) => setTimeout(r, 500)) },
      { timeoutMs: 50 },
    );
    const t0 = performance.now();
    expect(await p.failing()).toEqual(["bad", "no", "slow"]);
    expect(performance.now() - t0).toBeLessThan(300);
  });

  test("runs the checks at most once per ttl and shares one run between concurrent callers", async () => {
    let t = 1000;
    let calls = 0;
    let up = true;
    const p = healthProbe({ db: async () => (calls++, up) }, { ttlMs: 5000, now: () => t });
    expect(await Promise.all([p.failing(), p.failing(), p.failing()])).toEqual([[], [], []]);
    expect(calls).toBe(1);
    up = false;
    t += 4999;
    expect(await p.failing()).toEqual([]);
    expect(calls).toBe(1);
    t += 1;
    expect(await p.failing()).toEqual(["db"]);
    expect(calls).toBe(2);
  });
});

describe("health answer", () => {
  test("200 JSON with version and degraded, and headers that stop every cache", async () => {
    const r = healthResponse(await healthBody("api", "abc1234", healthProbe({ redis: async () => false })));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    for (const [k, v] of Object.entries(NO_STORE_HEADERS)) expect(r.headers.get(k)).toBe(v);
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(await r.json()).toEqual({ ok: true, service: "api", version: "abc1234", degraded: true, failing: ["redis"] });
    expect(await healthBody("ws", "dev")).toEqual({ ok: true, service: "ws", version: "dev", degraded: false, failing: [] });
  });
});
