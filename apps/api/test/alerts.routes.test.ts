// Todo 36 routes: register (webhook_register signature over URL and kinds, guard-checked URL, signing value once),
// list (owner read signature, shows why a webhook was turned off), remove. Needs DATABASE_URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { capstanMessage, closeDb, createDb, createTempDatabase, memoryNonceStore, type Db } from "@capstan/core";
import { encodeReadMessage, READ_MESSAGE_HEADER, READ_SIGNATURE_HEADER, readRequestBody } from "@capstan/risk";
import { registerBody, removeBody, secretDeriver } from "@capstan/workers/src/alerts";
import { job } from "@capstan/workers/src/jobs/alerts-dispatch.job";
import { Hono } from "hono";
import { testWallet } from "../../../packages/policy/test/accounts";
import { createAlertRoutes, type AlertRouteDeps } from "../src/routes/alerts.routes";

const PG = process.env.DATABASE_URL;
const HOST = "api.capstan.test";
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const owner = testWallet("alerts route owner");

(PG ? describe : describe.skip)("alert routes", () => {
  let t: Awaited<ReturnType<typeof createTempDatabase>>;
  let db: Db;
  let h: Hono;
  beforeAll(async () => {
    t = await createTempDatabase(PG!, { migrated: true, prefix: "capstan_alroutes" });
    db = createDb(t.url, { max: 2 });
    const deps: AlertRouteDeps = { db, nonces: memoryNonceStore(), host: HOST, deriveSecret: secretDeriver("route test key, public label, 32 bytes+"), resolver: async () => ["93.184.216.34"], now: () => NOW }; // test-key
    h = new Hono();
    for (const r of createAlertRoutes(() => deps)) h.on(r.method, `/v1${r.path}`, (c) => r.handler(c));
  }, 60_000);
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  }, 60_000);

  let k = 0;
  const sign = async (purpose: "webhook_register" | "read", body: string) => {
    const message = capstanMessage({ purpose, owner: owner.address, host: HOST, chainId: 4663, nonce: `alr-${k++}-nonce`, issuedAt: NOW - 1000, expiresAt: NOW + 60_000, body });
    return { message, sig: await owner.signMessage({ message }) };
  };

  test("register, list, remove", async () => {
    expect(job).toMatchObject({ name: "alerts-dispatch", queue: "alertsDispatch", schedule: { pattern: "30 2 * * *" } });
    const url = "https://hooks.example.com/capstan";
    const kinds = ["liq_distance", "approval_expiry"];
    const reg = await sign("webhook_register", registerBody(url, kinds as never));
    const res = await h.request("/v1/alerts/webhooks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: owner.address, url, kinds, ...reg }) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { id: string; secret: string; note: string };
    expect(j.secret).toMatch(/^whsec_/);
    expect(j.note).toContain("shown only once");
    // a private URL is refused
    const bad = await sign("webhook_register", registerBody("https://10.0.0.1/x", ["liq_distance"]));
    expect((await h.request("/v1/alerts/webhooks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: owner.address, url: "https://10.0.0.1/x", kinds: ["liq_distance"], ...bad }) })).status).toBe(400);
    // list needs the owner's read signature; the signing value is never listed
    const path = `/v1/alerts/webhooks?owner=${owner.address}`;
    expect((await h.request(path)).status).toBe(401);
    const rd = await sign("read", readRequestBody("GET", path));
    const list = await h.request(path, { headers: { [READ_MESSAGE_HEADER]: encodeReadMessage(rd.message), [READ_SIGNATURE_HEADER]: rd.sig } });
    expect(list.status).toBe(200);
    const lj = (await list.json()) as { webhooks: { id: string; disabled: boolean; kinds: string[] }[] };
    expect(lj.webhooks.map((w) => [w.id, w.disabled, w.kinds])).toEqual([[j.id, false, ["approval_expiry", "liq_distance"]]]);
    expect(JSON.stringify(lj)).not.toContain(j.secret);
    // remove
    const rm = await sign("webhook_register", removeBody(j.id));
    const del = await h.request(`/v1/alerts/webhooks/${j.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: owner.address, ...rm }) });
    expect(del.status).toBe(200);
    const rd2 = await sign("read", readRequestBody("GET", path));
    const after = (await (await h.request(path, { headers: { [READ_MESSAGE_HEADER]: encodeReadMessage(rd2.message), [READ_SIGNATURE_HEADER]: rd2.sig } })).json()) as { webhooks: unknown[] };
    expect(after.webhooks).toEqual([]);
  });
});
