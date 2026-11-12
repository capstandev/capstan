// The fork stack start race (queue proof r4, runs 1 and 3): Postgres passed its health check, then answered "the
// database system is starting up" to the migration, up.sh failed, and every-tx.ts scored the half-started stack.
// Here: (1) up.sh's retry loop rides out a database that says "starting up" for the first N tries and gives up after
// its bound; (2) every-tx.ts refuses to start, with a clear message and a non-zero exit, when a health check fails.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../lib";
import { assertStackHealthy, chainIs, httpOk, readyMarker, redisPing, stackHealth, StackNotReady, type HealthCheck } from "../preflight";

const dir = mkdtempSync(join(tmpdir(), "fork-start-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for the migration: fails with Postgres's own words until it has been called `failFirst` times. */
function fakeDb(name: string, failFirst: number): { script: string; count: () => number } {
  const counter = join(dir, `${name}.count`);
  const script = join(dir, `${name}.sh`);
  writeFileSync(counter, "0");
  writeFileSync(
    script,
    `#!/bin/bash\nn=$(( $(cat "${counter}") + 1 )); echo "$n" > "${counter}"\nif [ "$n" -le ${failFirst} ]; then echo "PostgresError: the database system is starting up" >&2; exit 1; fi\necho "migrate: applied"\n`,
    { mode: 0o755 },
  );
  return { script, count: () => Number(readFileSync(counter, "utf8").trim()) };
}

function retry(tries: number, script: string, log: string) {
  // the same call up.sh makes, under the same shell options (set -eu, /bin/bash 3.2 on macOS)
  const r = Bun.spawnSync(["/bin/bash", "-c", `set -eu; . "$1"; retry_cmd "$2" 0.05 "$3" "$4"`, "bash", join(ROOT, "ops/fork/db-wait.sh"), String(tries), log, script]);
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe("fork stack start: migration retry", () => {
  test("a database that says 'starting up' for the first 4 tries: the 5th try migrates", () => {
    const db = fakeDb("late", 4);
    const log = join(dir, "late.log");
    const r = retry(20, db.script, log);
    expect(r.code).toBe(0);
    expect(db.count()).toBe(5);
    expect(r.out).toContain("the database system is starting up");
    expect(r.out).toContain("succeeded on try 5 of 20");
    const text = readFileSync(log, "utf8");
    expect(text.match(/the database system is starting up/g)?.length).toBe(4);
    expect(text).toContain("migrate: applied");
  });

  test("a database that answers at once: one try, nothing printed", () => {
    const db = fakeDb("ready", 0);
    const r = retry(20, db.script, join(dir, "ready.log"));
    expect(r.code).toBe(0);
    expect(db.count()).toBe(1);
    expect(r.out).toBe("");
  });

  test("the loop is bounded: a database that never comes up fails after exactly the try count", () => {
    const db = fakeDb("never", 1_000_000);
    const r = retry(6, db.script, join(dir, "never.log"));
    expect(r.code).toBe(1);
    expect(db.count()).toBe(6);
  });

  test("a bad try count is refused, the command never runs", () => {
    const db = fakeDb("bad", 0);
    for (const n of ["0", "", "x"]) expect(retry(n as unknown as number, db.script, join(dir, "bad.log")).code).toBe(2);
    expect(db.count()).toBe(0);
  });

  test("up.sh migrates through the retry loop and marks the stack ready only at the end", () => {
    const up = readFileSync(join(ROOT, "ops/fork/up.sh"), "utf8");
    expect(up).toContain('. "$here/db-wait.sh"');
    expect(up).toMatch(/retry_cmd "\$\{FORK_DB_TRIES:-20\}" "\$\{FORK_DB_WAIT:-2\}" "\$logs\/migrate\.log" migrate_once \|\| \{[^\n]*exit 1; \}/);
    // the migration command appears once, inside migrate_once: no direct call is left
    expect(up.match(/packages\/core\/src\/migrate\.ts/g)?.length).toBe(1);
    const all = up.slice(up.indexOf("  all)"), up.indexOf("  apps) "));
    expect(all.indexOf('rm -f "$state/ready"')).toBeGreaterThan(-1);
    expect(all.indexOf('rm -f "$state/ready"')).toBeLessThan(all.indexOf("chain\n"));
    expect(all.indexOf('> "$state/ready"')).toBeGreaterThan(all.indexOf("    apps\n"));
    expect(readFileSync(join(ROOT, "ops/fork/down.sh"), "utf8")).toContain('rm -f "$here/.state/ready"');
  });
});

describe("every-tx refuses a stack that is not healthy", () => {
  const ok: HealthCheck = { name: "fine", run: async () => undefined };
  const startingUp: HealthCheck = {
    name: "postgres (migrated)",
    run: async () => {
      throw new Error("the database system is starting up");
    },
  };

  test("one failed check: StackNotReady names it and says no scenario ran", async () => {
    const e = await assertStackHealthy([ok, startingUp, ok], { tries: 2, waitMs: 1 }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(StackNotReady);
    const err = e as StackNotReady;
    expect(err.failed).toEqual(["postgres (migrated): the database system is starting up"]);
    expect(err.message).toContain("refuse: the fork stack is not healthy, no scenario ran (1 failed check)");
    expect(err.message).toContain("bash ops/fork/up.sh");
  });

  test("a check that recovers inside its tries passes; every check is reported", async () => {
    let n = 0;
    const flaky: HealthCheck = {
      name: "flaky",
      run: async () => {
        if (++n < 3) throw new Error("starting up");
      },
    };
    expect(await stackHealth([ok, flaky], { tries: 3, waitMs: 1 })).toEqual([
      { name: "fine", ok: true },
      { name: "flaky", ok: true },
    ]);
    await assertStackHealthy([ok, ok]);
  });

  test("the real checks: a 200 passes; a 503, a wrong chain id, a dead port and a missing marker fail", async () => {
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const p = new URL(req.url).pathname;
        if (p === "/health") return Response.json({ ok: true });
        if (p === "/rpc") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1237" }); // 4663
        return new Response("down", { status: 503 });
      },
    });
    const base = `http://127.0.0.1:${srv.port}`;
    const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const deadPort = dead.port as number;
    await dead.stop(true);
    try {
      const got = await stackHealth(
        [httpOk("up", `${base}/health`), chainIs("chain", `${base}/rpc`, 4663), httpOk("sick", `${base}/other`), chainIs("wrong chain", `${base}/rpc`, 8453), httpOk("dead", `http://127.0.0.1:${deadPort}/health`), redisPing(deadPort), readyMarker(dir)],
        { tries: 1 },
      );
      expect(got.map((r) => r.ok)).toEqual([true, true, false, false, false, false, false]);
      expect(got[2]!.error).toContain("answered 503");
      expect(got[3]!.error).toContain("chain id 4663, want 8453");
      expect(got[6]!.error).toContain("did not reach its 'ready:' line");
      writeFileSync(join(dir, "ready"), "now\n");
      expect((await stackHealth([readyMarker(dir)], { tries: 1 }))[0]!.ok).toBe(true);
    } finally {
      await srv.stop(true);
    }
  });

  test("the runner itself: no stack on these ports, so it exits 2 with the refusal and runs no scenario", () => {
    // every stack port moved to 1, where nothing listens
    const env: Record<string, string> = { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", FORK_REPORT_DIR: join(dir, "reports") };
    for (const k of ["API", "WS", "RELAY", "MCP", "FAC", "HL", "RH", "LM", "PG", "ANVIL", "CACHE", "BASE", "WEB", "REDIS"]) env[`FORK_P_${k}`] = "1";
    const r = Bun.spawnSync([process.execPath, join(ROOT, "ops/fork/every-tx.ts")], { cwd: ROOT, env });
    const out = r.stdout.toString() + r.stderr.toString();
    expect(r.exitCode).toBe(2);
    expect(out).toContain("refuse: the fork stack is not healthy, no scenario ran");
    expect(out).not.toMatch(/S\d+: (pass|FAIL)/);
    expect(out).not.toContain("scenarios passed");
  }, 60_000);
});
