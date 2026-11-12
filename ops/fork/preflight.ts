// The stack health checks every-tx.ts runs before its first scenario. A stack that ops/fork/up.sh did not finish
// starting (a failed migration, an app that never listened) is refused with one clear message and a non-zero exit,
// so a start failure is never reported as a scenario score. Every check talks to loopback only.
import { closeDb, createDb } from "@capstan/core";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { BASE, DATABASE_URL, PORTS, RHC, STATE } from "./lib";

export interface HealthCheck {
  name: string;
  run: () => Promise<void>; // resolves when healthy, throws with the reason when not
}
export interface HealthResult {
  name: string;
  ok: boolean;
  error?: string;
}

/** Thrown when the stack is not fully up. `failed` holds one "name: reason" line per failed check. */
export class StackNotReady extends Error {
  constructor(readonly failed: string[]) {
    super(
      `refuse: the fork stack is not healthy, no scenario ran (${failed.length} failed check${failed.length === 1 ? "" : "s"}):\n` +
        failed.map((f) => `  - ${f}`).join("\n") +
        "\nStart it again: bash ops/fork/down.sh && bash ops/fork/up.sh (it must end with a 'ready:' line; logs in ops/fork/.state/logs).",
    );
    this.name = "StackNotReady";
  }
}

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${what}: no answer in ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), res(v)),
      (e) => (clearTimeout(t), rej(e as Error)),
    );
  });

/** GET url must answer 200. */
export function httpOk(name: string, url: string, f: typeof fetch = fetch): HealthCheck {
  return {
    name,
    async run() {
      const r = await f(url, { signal: AbortSignal.timeout(5000) });
      await r.arrayBuffer().catch(() => undefined);
      if (r.status !== 200) throw new Error(`GET ${url} answered ${r.status}`);
    },
  };
}

/** eth_chainId on a loopback RPC must be the expected chain. */
export function chainIs(name: string, url: string, id: number, f: typeof fetch = fetch): HealthCheck {
  return {
    name,
    async run() {
      const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(5000) });
      const got = Number(((await r.json()) as { result?: string }).result);
      if (got !== id) throw new Error(`${url} answered chain id ${got}, want ${id}`);
    },
  };
}

/** Postgres answers and the migrations ran (the migration table has rows). */
export function postgresMigrated(url = DATABASE_URL): HealthCheck {
  return {
    name: "postgres (migrated)",
    async run() {
      const db = createDb(url, { max: 1 });
      try {
        const rows = (await within(db.$client`select count(*)::int as n from capstan_migrations`, 5000, "postgres")) as unknown as { n: number }[];
        if (!rows[0] || rows[0].n < 1) throw new Error("no migration is applied");
      } finally {
        await closeDb(db).catch(() => undefined);
      }
    },
  };
}

/** Redis answers PING (a plain socket: a client library would retry a dead port for ever). */
export function redisPing(port: number = PORTS.redis): HealthCheck {
  return {
    name: "redis",
    run: () =>
      within(
        new Promise<void>((res, rej) => {
          const s = connect({ host: "127.0.0.1", port });
          s.once("error", (e) => rej(e));
          s.once("connect", () => s.write("PING\r\n"));
          s.once("data", (d) => {
            s.destroy();
            if (d.toString().startsWith("+PONG")) res();
            else rej(new Error(`redis answered ${JSON.stringify(d.toString().slice(0, 40))}`));
          });
        }),
        5000,
        "redis",
      ),
  };
}

/** up.sh writes the marker as its last step and removes it when a new start begins; down.sh removes it too. */
export function readyMarker(state = STATE): HealthCheck {
  return {
    name: "up.sh finished",
    async run() {
      if (!existsSync(join(state, "ready"))) throw new Error("ops/fork/up.sh did not reach its 'ready:' line (no .state/ready marker)");
    },
  };
}

export function defaultChecks(): HealthCheck[] {
  const local = (p: number, path: string) => `http://127.0.0.1:${p}${path}`;
  return [
    readyMarker(),
    chainIs("RHC fork", RHC, 4663),
    chainIs("Base fork", BASE, 8453),
    postgresMigrated(),
    redisPing(),
    httpOk("api", local(PORTS.api, "/v1/health")),
    httpOk("ws", local(PORTS.ws, "/health")),
    httpOk("relay", local(PORTS.relay, "/health")),
    httpOk("mcp", local(PORTS.mcp, "/health")),
    httpOk("facilitator", local(PORTS.facilitator, "/health")),
  ];
}

/** Runs every check (each one up to `tries` times, `waitMs` apart) and reports all of them, healthy or not. */
export async function stackHealth(checks: HealthCheck[], o: { tries?: number; waitMs?: number } = {}): Promise<HealthResult[]> {
  const tries = Math.max(1, o.tries ?? 3);
  const waitMs = o.waitMs ?? 1000;
  return Promise.all(
    checks.map(async (c): Promise<HealthResult> => {
      let error = "";
      for (let i = 0; i < tries; i++) {
        try {
          await c.run();
          return { name: c.name, ok: true };
        } catch (e) {
          error = ((e as Error).message ?? String(e)).split("\n")[0]!.slice(0, 200);
          if (i + 1 < tries) await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      return { name: c.name, ok: false, error };
    }),
  );
}

/** Throws StackNotReady naming every failed check; returns quietly when the whole stack answers. */
export async function assertStackHealthy(checks: HealthCheck[] = defaultChecks(), o: { tries?: number; waitMs?: number } = {}): Promise<void> {
  const failed = (await stackHealth(checks, o)).filter((r) => !r.ok);
  if (failed.length > 0) throw new StackNotReady(failed.map((r) => `${r.name}: ${r.error}`));
}
