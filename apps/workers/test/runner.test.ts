// R8: WORKER_JOBS must name known jobs; the process refuses to start otherwise, naming the unknown job.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverJobs, RunnerError, selectJobs } from "../src/runner";

const dir = mkdtempSync(join(tmpdir(), "capstan-jobs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("runner", () => {
  test("unknown-job", () => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/index.ts")], {
      env: { ...process.env, WORKER_JOBS: "nope", DATABASE_URL: "postgres://x@127.0.0.1:1/x", REDIS_URL: "redis://127.0.0.1:1", ANCHOR_SIGNER: "dev", LOG_LEVEL: "error" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString()).toContain("unknown job nope");
  });

  test("discovers *.job.ts sorted and selects a subset", async () => {
    const body = (name: string) => `export const job = { name: "${name}", queue: "catalogSync", concurrency: 1, handler: async () => "${name}" };\n`;
    writeFileSync(join(dir, "b.job.ts"), body("b-job"));
    writeFileSync(join(dir, "a.job.ts"), body("a-job"));
    writeFileSync(join(dir, "notes.ts"), "export const x = 1;\n");
    const jobs = await discoverJobs(dir);
    expect(jobs.map((j) => j.name)).toEqual(["a-job", "b-job"]);
    expect(selectJobs(jobs, "").map((j) => j.name)).toEqual(["a-job", "b-job"]);
    expect(selectJobs(jobs, " b-job ").map((j) => j.name)).toEqual(["b-job"]);
    expect(() => selectJobs(jobs, "b-job,nope")).toThrow(new RunnerError("unknown job nope (known: a-job, b-job)"));
  });

  test("a malformed job file is refused", async () => {
    const bad = mkdtempSync(join(tmpdir(), "capstan-badjobs-"));
    try {
      writeFileSync(join(bad, "x.job.ts"), `export const job = { name: "x", queue: "nope", concurrency: 1, handler: async () => 1 };\n`);
      await expect(discoverJobs(bad)).rejects.toThrow("job x has an unknown queue");
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });
});
