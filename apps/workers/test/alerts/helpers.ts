// Alert test helpers: a temp database, a local receiver on port 0 behind a transport that maps the checked IP to it,
// and webhook rows.
import { closeDb, createDb, createTempDatabase, schema, type Db } from "@capstan/core";
import type { PinnedRequest, Transport } from "../../src/alerts";
import { secretDeriver, sha256Hex } from "../../src/alerts";

export const PG = process.env.DATABASE_URL;
export const NOW = new Date("2026-11-01T12:00:00.000Z");
export const OWNER = "0x00000000000000000000000000000000000000d4" as const;
export const derive = secretDeriver("capstan alerts test key, public label, 32+ bytes"); // test-key (public label)

export async function tempDb(): Promise<{ db: Db; drop(): Promise<void> }> {
  const t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_alerts" });
  const db = createDb(t.url, { max: 2 });
  return { db, drop: async () => (await closeDb(db), await t.drop()) };
}

export interface Received {
  headers: Record<string, string>;
  body: string;
}

/** A local receiver (Bun.serve on port 0) and a transport that sends the pinned request to it over plain HTTP. */
export function receiver(answer: (n: number) => Response | Promise<Response> = () => new Response("ok")) {
  const got: Received[] = [];
  let n = 0;
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      got.push({ headers, body: await req.text() });
      return answer(n++);
    },
  });
  const pinned: PinnedRequest[] = [];
  const transport: Transport = async (r) => {
    pinned.push(r);
    const res = await fetch(`http://127.0.0.1:${srv.port}${r.path}`, { method: "POST", headers: { ...r.headers, "x-test-host": r.host }, body: r.body, redirect: "manual", signal: AbortSignal.timeout(r.timeoutMs) });
    await res.arrayBuffer();
    return { status: res.status, ...(res.headers.get("location") ? { location: res.headers.get("location")! } : {}) };
  };
  return { got, pinned, transport, stop: () => srv.stop(true) };
}

export async function addWebhook(db: Db, id: string, o: { url?: string; kinds?: string[]; owner?: string; failures?: number } = {}) {
  await db.insert(schema.webhooks).values({ id, owner: (o.owner ?? OWNER).toLowerCase(), url: o.url ?? "https://hooks.example.com/capstan?token=abc", secretHash: sha256Hex(derive(id)), kinds: o.kinds ?? ["liq_distance", "plan_unhedged", "approval_expiry", "policy_breach"], consecutiveFailures: o.failures ?? 0 });
}

export const publicResolver = async () => ["93.184.216.34"];
