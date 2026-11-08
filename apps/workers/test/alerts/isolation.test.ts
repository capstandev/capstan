// R1-8-03 (security review round 1): a wallet's slow webhooks and self-reported plan alerts must not stall real users'
// liquidation alerts or the team's ops alerts.
//   - ops-alerts runs on its own queue, never behind user webhook work;
//   - liq_distance work is taken before user-triggerable work (plan_unhedged, policy_breach) already queued;
//   - one alert holds a worker slot for at most the delivery budget, even with 5 slow or silent hooks;
//   - the webhook host's name lookup has its own time limit;
//   - user-triggerable alerts are capped per owner per minute;
//   - every producer (api order build, relay submit, risk-compute, spread events) sets the queue priority, so a
//     policy_breach refusal never runs ahead of a liquidation alert (an add with no priority runs before all of them);
//   - at the budget the request is aborted (socket destroyed), not only the wait for it;
//   - a hook slower than 2 s on 3 deliveries in a row is turned off;
//   - one caller-triggerable alert runs at a time per owner (a busy owner's next one goes back as delayed).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ALERT_JOB, ALERT_PRIORITY, createRedis, QUEUES, schema, type Db } from "@capstan/core";
import { DelayedError, Queue, Worker } from "bullmq";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { dispatch, enqueueAlertWork, enqueuePolicyBreach, guardUrl, memorySlowStreak, pinnedHttps, redisOwnerLock, SLOW_DISABLE_AFTER, type AlertEvent, type OwnerLock, type Transport } from "../../src/alerts";
import { job as alertsJob, oneAtATimePerOwner } from "../../src/jobs/alerts-dispatch.job";
import { job as opsJob } from "../../src/jobs/ops-alerts.job";
import { MOVED_SCHEDULERS } from "../../src/runner";
import { addWebhook, derive, NOW, OWNER, PG, publicResolver, tempDb } from "./helpers";

const REDIS = process.env.REDIS_URL;

describe("alert isolation (R1-8-03)", () => {
  test("ops-alerts has its own queue", () => {
    expect(opsJob.queue).not.toBe(alertsJob.queue);
    expect(QUEUES[opsJob.queue]).not.toBe(QUEUES[alertsJob.queue]);
    // the old 15 s scheduler on the user alert queue is removed when that queue's worker starts
    expect(MOVED_SCHEDULERS[alertsJob.queue]).toContain(opsJob.name);
  });

  test("the webhook host lookup times out", async () => {
    const t0 = performance.now();
    const g = await guardUrl("https://slow-dns.example.com/h", () => new Promise<string[]>(() => undefined), { lookupTimeoutMs: 200 });
    expect(g.ok).toBe(false);
    expect(performance.now() - t0).toBeLessThan(2000);
  }, 10_000);
});

const ROOT = join(import.meta.dir, "../../../..");
function sources(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "test" || n === "dist") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

describe("every alert producer sets the queue priority (R1-8-03)", () => {
  const files = [...sources(join(ROOT, "apps")), ...sources(join(ROOT, "packages"))];
  const SHARED = join(ROOT, "packages/core/src/alert-queue.ts");

  test("nothing adds to the alert queue directly", () => {
    // a job added with no priority runs before every prioritised one: only the shared helper calls add
    const direct = /\.add\(\s*(["'`]alerts-dispatch["'`]|ALERT_JOB\b|QUEUES\.alertsDispatch\b)/;
    const bad = files.filter((f) => f !== SHARED && direct.test(readFileSync(f, "utf8"))).map((f) => f.slice(ROOT.length + 1));
    expect(bad).toEqual([]);
  });

  test("each file that opens the alert queue produces through the shared helpers", () => {
    const opens = /new Queue\(\s*(["'`]alerts-dispatch["'`]|QUEUES\.alertsDispatch\b)|createQueue\(\s*["'`]alertsDispatch["'`]/;
    const helper = /\b(enqueuePolicyBreach|enqueueAlertWork|enqueueAlertJob)\(/;
    const producers = files.filter((f) => opens.test(readFileSync(f, "utf8")));
    // the api order routes, the relay wiring, risk-compute and the spread routes
    expect(producers.map((f) => f.slice(ROOT.length + 1)).sort()).toEqual(["apps/api/src/routes/orders.routes.ts", "apps/api/src/routes/spreads.routes.ts", "apps/relay/src/wire.ts", "apps/workers/src/jobs/risk-compute.job.ts"]);
    for (const f of producers) expect({ f, ok: helper.test(readFileSync(f, "utf8")) }).toEqual({ f, ok: true });
  });

  test("a policy breach is queued behind liquidation work, with the owner lower-cased", async () => {
    const added: { name: string; data: unknown; opts: unknown }[] = [];
    const q = { add: async (name: string, data: unknown, opts?: unknown) => void added.push({ name, data, opts }) };
    await enqueuePolicyBreach(q, { owner: "0x00000000000000000000000000000000000000AB", agentRef: "agent-1", field: "maxNotional" });
    expect(added).toEqual([{ name: ALERT_JOB, data: { source: "policy_breach", owner: "0x00000000000000000000000000000000000000ab", agentRef: "agent-1", field: "maxNotional" }, opts: { removeOnComplete: 1000, removeOnFail: 5000, priority: ALERT_PRIORITY.policy_breach } }]);
    expect(ALERT_PRIORITY.policy_breach).toBeGreaterThan(ALERT_PRIORITY.risk);
    expect(ALERT_PRIORITY.plan).toBeGreaterThan(ALERT_PRIORITY.risk);
  });
});

describe("one caller-triggerable alert at a time per owner (R1-8-03)", () => {
  const held = new Set<string>();
  const lock: OwnerLock = { take: async (o) => (held.has(o) ? null : (held.add(o), { release: async () => void held.delete(o) })) };
  const fakeJob = () => {
    const moved: number[] = [];
    return { moved, j: { moveToDelayed: async (ts: number) => void moved.push(ts) } };
  };
  const plan = { source: "plan", owner: OWNER, planId: "P1", kind: "unhedged", data: {} } as const;

  test("a second plan alert of a busy owner goes back as delayed and frees the slot", async () => {
    let release!: () => void;
    const first = oneAtATimePerOwner(fakeJob().j, plan, lock, "t1", () => new Promise<string>((r) => (release = () => r("first"))));
    await Bun.sleep(5);
    const b = fakeJob();
    let ran = false;
    await expect(oneAtATimePerOwner(b.j, { ...plan, planId: "P2" }, lock, "t2", async () => (ran = true), () => 1000)).rejects.toBeInstanceOf(DelayedError);
    expect(ran).toBe(false);
    expect(b.moved).toEqual([2000]);
    // another owner and a liquidation alert of the same owner are not held up
    expect(await oneAtATimePerOwner(fakeJob().j, { ...plan, owner: "0x00000000000000000000000000000000000000e5" }, lock, "t3", async () => "other")).toBe("other");
    expect(await oneAtATimePerOwner(fakeJob().j, { source: "risk", owner: OWNER, ladder: [] }, lock, "t4", async () => "risk")).toBe("risk");
    release();
    expect(await first).toBe("first");
    // released: the next one runs
    expect(await oneAtATimePerOwner(fakeJob().j, { ...plan, planId: "P3" }, lock, "t5", async () => "next")).toBe("next");
  });
});

describe("the request is aborted at the budget (R1-8-03)", () => {
  test("pinnedHttps destroys the socket when the caller aborts, before its own timeout", async () => {
    let closedAt = 0;
    const socks: Socket[] = [];
    // accepts the connection and never answers (a host that holds the socket open)
    const srv = createServer((s) => {
      socks.push(s);
      // read (and drop) what the client sends, so the client's close is seen
      s.resume();
      s.on("close", () => (closedAt = performance.now()));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const ac = new AbortController();
    try {
      const t0 = performance.now();
      const p = pinnedHttps({ ip: "127.0.0.1", family: 4, host: "hooks.example.com", port, path: "/h", headers: {}, body: "{}", timeoutMs: 20_000, signal: ac.signal });
      setTimeout(() => ac.abort(), 200);
      await expect(p).rejects.toThrow("aborted");
      await Bun.sleep(100);
      expect(closedAt).toBeGreaterThan(0);
      expect(closedAt - t0).toBeLessThan(2000);
    } finally {
      for (const s of socks) s.destroy();
      srv.close();
    }
  }, 10_000);

  test("pinnedHttps cuts the request at timeoutMs", async () => {
    const socks: Socket[] = [];
    const srv = createServer((s) => void socks.push(s));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      const t0 = performance.now();
      await expect(pinnedHttps({ ip: "127.0.0.1", family: 4, host: "hooks.example.com", port, path: "/h", headers: {}, body: "{}", timeoutMs: 300 })).rejects.toThrow("timeout");
      expect(performance.now() - t0).toBeLessThan(2000);
    } finally {
      for (const s of socks) s.destroy();
      srv.close();
    }
  }, 10_000);
});

(REDIS ? describe : describe.skip)("alert queue order (R1-8-03, Redis)", () => {
  test("a liquidation alert queued behind 100 plan alerts is taken first", async () => {
    const prefix = `capstan-r1803-${process.pid}`;
    const conn = createRedis(REDIS!, { forBullmq: true });
    const q = new Queue(QUEUES.alertsDispatch, { connection: conn, prefix });
    try {
      for (let i = 0; i < 100; i++) await enqueueAlertWork(q, { source: "plan", owner: OWNER, planId: `P${i}`, kind: "unhedged", data: { residualDeltaBase: "1" } });
      await enqueueAlertWork(q, { source: "risk", owner: OWNER, ladder: [] });
      const order: string[] = [];
      await new Promise<void>((resolve) => {
        const w = new Worker(
          QUEUES.alertsDispatch,
          async (j) => {
            order.push((j.data as { source: string }).source);
            if (order.length === 3) void w.close().then(resolve);
          },
          { connection: conn, prefix, concurrency: 1 },
        );
      });
      expect(order[0]).toBe("risk");
    } finally {
      await q.obliterate({ force: true });
      await q.close();
      conn.disconnect();
    }
  }, 30_000);
});

(REDIS ? describe : describe.skip)("policy breach order and owner lock (R1-8-03, Redis)", () => {
  test("a liquidation alert queued behind 20 policy breach refusals is taken first", async () => {
    const prefix = `capstan-r1803pb-${process.pid}`;
    const conn = createRedis(REDIS!, { forBullmq: true });
    const q = new Queue(QUEUES.alertsDispatch, { connection: conn, prefix });
    try {
      for (let i = 0; i < 20; i++) await enqueuePolicyBreach(q, { owner: OWNER, agentRef: `a${i}`, field: "maxNotional" });
      await enqueueAlertWork(q, { source: "risk", owner: OWNER, ladder: [] });
      const order: string[] = [];
      await new Promise<void>((resolve) => {
        const w = new Worker(
          QUEUES.alertsDispatch,
          async (j) => {
            order.push((j.data as { source: string }).source);
            if (order.length === 3) void w.close().then(resolve);
          },
          { connection: conn, prefix, concurrency: 1 },
        );
      });
      expect(order[0]).toBe("risk");
    } finally {
      await q.obliterate({ force: true });
      await q.close();
      conn.disconnect();
    }
  }, 30_000);

  test("the Redis owner lock admits one holder and frees on release or expiry", async () => {
    const redis = createRedis(REDIS!);
    const owner = `0x${process.pid.toString(16).padStart(40, "0")}`;
    try {
      const lock = redisOwnerLock(redis);
      const a = await lock.take(owner, 5000);
      expect(a).not.toBeNull();
      expect(await lock.take(owner.toUpperCase().replace("0X", "0x"), 5000)).toBeNull();
      await a!.release();
      const b = await lock.take(owner, 150);
      expect(b).not.toBeNull();
      await Bun.sleep(300);
      // expired: another holder may take it, and the stale holder's release leaves the new one alone
      const c = await lock.take(owner, 5000);
      expect(c).not.toBeNull();
      await b!.release();
      expect(await lock.take(owner, 5000)).toBeNull();
      await c!.release();
    } finally {
      redis.disconnect();
    }
  }, 10_000);
});

(PG ? describe : describe.skip)("delivery budget and caps (R1-8-03, Postgres)", () => {
  let t: Awaited<ReturnType<typeof tempDb>>;
  let db: Db;
  beforeAll(async () => {
    t = await tempDb();
    db = t.db;
  }, 60_000);
  afterAll(async () => t?.drop(), 60_000);
  const ev = (o: Partial<AlertEvent> = {}): AlertEvent => ({ kind: "liq_distance", owner: OWNER, data: { distancePct: 3 }, ...o });
  const BUDGET = 1500;
  const base = (http: Transport) => ({ db, now: () => NOW, secretOf: derive, resolver: publicResolver, sleep: async () => {}, http, budgetMs: BUDGET });
  const wipe = async () => {
    await db.delete(schema.alertEvents);
    await db.delete(schema.webhooks);
  };

  test("5 hooks that answer just inside the timeout hold the job no longer than the budget", async () => {
    for (let i = 0; i < 5; i++) await addWebhook(db, `wh-slow-${i}`);
    // answers 200 after 490 ms (never past a timeout it is given), like a host that waits just under the limit
    const http: Transport = (r) => new Promise((res, rej) => (r.timeoutMs < 490 ? setTimeout(() => rej(new Error("timeout")), r.timeoutMs) : setTimeout(() => res({ status: 200 }), 490)));
    try {
      const t0 = performance.now();
      await dispatch(ev(), base(http));
      expect(performance.now() - t0).toBeLessThan(BUDGET + 400);
    } finally {
      await wipe();
    }
  }, 30_000);

  test("hooks that never finish answering (a trickling host) are cut at the budget", async () => {
    for (let i = 0; i < 5; i++) await addWebhook(db, `wh-hang-${i}`);
    const http: Transport = () => new Promise(() => undefined);
    try {
      const t0 = performance.now();
      expect(await dispatch(ev(), base(http))).toBe(0);
      expect(performance.now() - t0).toBeLessThan(BUDGET + 400);
      const rows = await db.select().from(schema.alertEvents);
      expect(rows.length).toBe(5);
      expect(rows.every((r) => r.status === "failed")).toBe(true);
    } finally {
      await wipe();
    }
  }, 20_000);

  test("at the budget the hook request is aborted, not only abandoned", async () => {
    await addWebhook(db, "wh-abort");
    const signals: AbortSignal[] = [];
    const http: Transport = (r) => (r.signal && signals.push(r.signal), new Promise(() => undefined));
    try {
      expect(await dispatch(ev(), { ...base(http), budgetMs: 300 })).toBe(0);
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((x) => x.aborted)).toBe(true);
    } finally {
      await wipe();
    }
  }, 10_000);

  test("a hook slower than 2 s on 3 deliveries in a row is turned off; a fast one resets the streak", async () => {
    await addWebhook(db, "wh-sluggish");
    let t = 0;
    let delay = 2500;
    const http: Transport = async () => ((t += delay), { status: 200 });
    const slow = memorySlowStreak();
    const d = { ...base(http), budgetMs: 10_000, clock: () => t, slow };
    const disabled = async () => (await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, "wh-sluggish")))[0]!;
    try {
      for (let i = 0; i < SLOW_DISABLE_AFTER - 1; i++) expect(await dispatch(ev({ data: { n: i } }), d)).toBe(1);
      delay = 50;
      expect(await dispatch(ev({ data: { n: "fast" } }), d)).toBe(1);
      delay = 2500;
      for (let i = 0; i < SLOW_DISABLE_AFTER - 1; i++) expect(await dispatch(ev({ data: { n: `s${i}` } }), d)).toBe(1);
      expect((await disabled()).disabled).toBe(false);
      expect(await dispatch(ev({ data: { n: "last" } }), d)).toBe(1);
      const w = await disabled();
      expect(w.disabled).toBe(true);
      expect(w.disabledReason).toContain("slower than 2 s");
      // turned off: nothing more is sent to it
      expect(await dispatch(ev({ data: { n: "after" } }), d)).toBe(0);
    } finally {
      await wipe();
    }
  }, 30_000);

  test("user-triggerable alerts are capped per owner per minute; liquidation alerts are not", async () => {
    await addWebhook(db, "wh-cap");
    const http: Transport = async () => ({ status: 200 });
    try {
      let delivered = 0;
      for (let i = 0; i < 20; i++) delivered += await dispatch(ev({ kind: "plan_unhedged", data: { planId: `P${i}` } }), base(http));
      expect(delivered).toBeLessThanOrEqual(10);
      let liq = 0;
      for (let i = 0; i < 3; i++) liq += await dispatch(ev({ data: { n: i } }), base(http));
      expect(liq).toBe(3);
    } finally {
      await wipe();
    }
  }, 30_000);
});
