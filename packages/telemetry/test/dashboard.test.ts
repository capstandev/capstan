import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { METRICS } from "../src";

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("dashboards", () => {
  test("dashboard.json has one panel per metric and names only real metrics", () => {
    const d = JSON.parse(readFileSync(join(ROOT, "ops/dashboards/dashboard.json"), "utf8")) as { panels: { targets: { expr: string }[] }[] };
    const exprs = d.panels.flatMap((p) => p.targets.map((t) => t.expr)).join("\n");
    for (const m of Object.values(METRICS)) expect(exprs).toContain(m.name);
    const names = new Set(Object.values(METRICS).map((m) => m.name));
    for (const used of exprs.match(/capstan_[a-z0-9_]+/g) ?? []) expect(names.has(used.replace(/_(bucket|sum|count)$/, ""))).toBeTrue();
  });

  test("prometheus.yml scrapes only 127.0.0.1", () => {
    const y = readFileSync(join(ROOT, "ops/dashboards/prometheus.yml"), "utf8");
    const targets = [...y.matchAll(/targets: \["([^"]+)"\]/g)].map((m) => m[1]!);
    expect(targets.length).toBe(6);
    for (const t of targets) expect(t).toStartWith("127.0.0.1:");
  });
});
