// Runs the team bot's end-to-end suite (ops/teambot/tests, Python stdlib unittest) inside `bun test`, so the gate
// covers it. The suite starts its own stand-in Telegram API (ops/alerts/telegram-standin.ts) on TEAMBOT_STANDIN_PORT.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const python = spawnSync("python3", ["--version"]).status === 0;

test.skipIf(!python)("team bot: every command against the stand-in Telegram API", () => {
  const r = spawnSync("python3", ["-m", "unittest", "discover", "-s", "ops/teambot/tests", "-t", "."], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, TEAMBOT_STANDIN_PORT: process.env.TEAMBOT_STANDIN_PORT ?? "25582" },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0) console.error(out.slice(-4000));
  expect(r.status).toBe(0);
  expect(out).toMatch(/Ran \d+ tests/);
}, 150_000);
