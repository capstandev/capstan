import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const FILES = [
  ...readdirSync(join(ROOT, "packages/telemetry/src")).map((f) => join("packages/telemetry/src", f)),
  "apps/workers/src/jobs/ops-alerts.job.ts",
  "apps/workers/src/jobs/log-retention.job.ts",
];
// anything that could stop, pause or kill: the kill switch, relay or venue flags, the policy package, flag wrappers
const FORBIDDEN = [/\bkill\s*\(/, /KillSwitch|isKilled|redisKillSwitch|buildKillResponse/, /\b[A-Z0-9_]+_ENABLED\b/, /capstan-relay-flag/, /@capstan\/(policy|relay)\b/, /\bsetFlag\b|\bpause\s*\(/, /RELAY_SUBMIT_ARMED/];

describe("MON-1", () => {
  test("notify-only: telemetry and alert code never calls into kill, relay flags or venue flags", () => {
    const hits: string[] = [];
    for (const f of FILES) {
      const text = readFileSync(join(ROOT, f), "utf8");
      text.split("\n").forEach((line, i) => {
        for (const re of FORBIDDEN) if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
    expect(FILES.length).toBeGreaterThan(8);
  });
});
