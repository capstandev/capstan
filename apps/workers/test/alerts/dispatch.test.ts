// R3 no redirects, R4 HMAC signature and timestamp verified on a local receiver, R8 disable after 20 failures with the
// reason visible, R10 alert_events holds the payload hash only. Needs DATABASE_URL.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema, type Db } from "@capstan/core";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { dispatch, listWebhooks, sha256Hex, type AlertEvent } from "../../src/alerts";
import { addWebhook, derive, NOW, OWNER, PG, publicResolver, receiver, tempDb } from "./helpers";

const ev = (o: Partial<AlertEvent> = {}): AlertEvent => ({ kind: "liq_distance", owner: OWNER, data: { marketId: "hyperliquid:-:ETH", distancePct: 4.2 }, ...o });
const d = PG ? describe : describe.skip;

d("dispatch", () => {
  let t: Awaited<ReturnType<typeof tempDb>>;
  let db: Db;
  beforeAll(async () => {
    t = await tempDb();
    db = t.db;
  }, 60_000);
  afterAll(async () => t?.drop(), 60_000);
  const base = () => ({ db, now: () => NOW, secretOf: derive, resolver: publicResolver, sleep: async () => {} });

  test("hmac", async () => {
    await addWebhook(db, "wh-hmac");
    const r = receiver();
    try {
      expect(await dispatch(ev(), { ...base(), http: r.transport })).toBe(1);
      expect(r.got.length).toBe(1);
      const g = r.got[0]!;
      // the receiver checks the signature with the value it was shown at registration
      const want = createHmac("sha256", derive("wh-hmac")).update(g.body).digest("hex");
      expect(g.headers["x-capstan-signature"]).toBe(want);
      expect(g.headers["x-capstan-timestamp"]).toBe(NOW.toISOString());
      expect(JSON.parse(g.body)).toMatchObject({ kind: "liq_distance", owner: OWNER, ts: NOW.toISOString(), data: { distancePct: 4.2 } });
      // sent to the IP the guard checked, with the original host for TLS and Host
      expect(r.pinned[0]).toMatchObject({ ip: "93.184.216.34", host: "hooks.example.com", port: 443, path: "/capstan?token=abc", timeoutMs: 5000 });
      // a tampered body fails the check
      expect(createHmac("sha256", derive("wh-hmac")).update(g.body.replace("4.2", "9.9")).digest("hex")).not.toBe(want);
      // nothing in the delivery carries a key or a signed user payload
      expect(g.body).not.toMatch(/whsec_|signature|private|0x[0-9a-f]{64}/i);
    } finally {
      r.stop();
      await db.delete(schema.alertEvents);
      await db.delete(schema.webhooks);
    }
  });

  test("no-redirects", async () => {
    await addWebhook(db, "wh-302");
    const r = receiver(() => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } }));
    try {
      expect(await dispatch(ev(), { ...base(), http: r.transport })).toBe(0);
      expect(r.got.length).toBe(1); // tried once, the redirect was not followed (and not retried)
      const [row] = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.webhookId, "wh-302"));
      expect(row!.status).toBe("failed");
      const [w] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, "wh-302"));
      expect(w!.consecutiveFailures).toBe(1);
    } finally {
      r.stop();
      await db.delete(schema.alertEvents);
      await db.delete(schema.webhooks);
    }
  });

  test("retries then a rebinding answer is refused before connecting", async () => {
    await addWebhook(db, "wh-rebind", { url: "https://rebind.example.com/h" });
    let n = 0;
    const flip = async () => (n++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]);
    const r = receiver(() => new Response("busy", { status: 503 }));
    try {
      expect(await dispatch(ev(), { ...base(), resolver: flip, http: r.transport })).toBe(0);
      expect(r.pinned.map((p) => p.ip)).toEqual(["93.184.216.34"]); // the private answer never reached the transport
    } finally {
      r.stop();
      await db.delete(schema.alertEvents);
      await db.delete(schema.webhooks);
    }
  });

  test("disable", async () => {
    await addWebhook(db, "wh-dead", { failures: 18 });
    const r = receiver(() => new Response("no", { status: 500 }));
    try {
      expect(await dispatch(ev(), { ...base(), http: r.transport })).toBe(0);
      expect(r.got.length).toBe(4); // one try and 3 retries
      let [w] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, "wh-dead"));
      expect([w!.consecutiveFailures, w!.disabled]).toEqual([19, false]);
      expect(await dispatch(ev({ data: { n: 2 } }), { ...base(), http: r.transport })).toBe(0);
      [w] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, "wh-dead"));
      expect([w!.consecutiveFailures, w!.disabled]).toEqual([20, true]);
      // the owner sees why
      const listed = await listWebhooks(db, OWNER);
      expect(listed.find((x) => x.id === "wh-dead")!.disabledReason).toContain("20 failed deliveries in a row. Last error: HTTP 500");
      // a disabled webhook gets nothing more
      const before = r.got.length;
      await dispatch(ev({ data: { n: 3 } }), { ...base(), http: r.transport });
      expect(r.got.length).toBe(before);
      // a success resets the count
      await addWebhook(db, "wh-flaky", { failures: 7 });
      const ok = receiver();
      await dispatch(ev(), { ...base(), http: ok.transport });
      const [f] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, "wh-flaky"));
      expect(f!.consecutiveFailures).toBe(0);
      ok.stop();
    } finally {
      r.stop();
      await db.delete(schema.alertEvents);
      await db.delete(schema.webhooks);
    }
  });

  test("hash-only", async () => {
    await addWebhook(db, "wh-hash", { url: "https://hooks.example.com/p?secretToken=s3cr3t-in-query" });
    const r = receiver();
    try {
      await dispatch(ev({ data: { marketId: "hyperliquid:-:BTC", note: "body text that must not be stored" } }), { ...base(), http: r.transport });
      const rows = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.webhookId, "wh-hash"));
      expect(rows.length).toBe(1);
      const stored = JSON.stringify(rows[0]);
      expect(rows[0]!.payloadHash).toBe(sha256Hex(r.got[0]!.body));
      expect(stored).not.toContain("body text that must not be stored");
      expect(stored).not.toContain("s3cr3t-in-query");
      expect(stored).not.toContain("hooks.example.com");
      expect(Object.keys(rows[0]!).sort()).toEqual(["attempts", "dedupeKey", "id", "kind", "payloadHash", "status", "ts", "webhookId"]);
    } finally {
      r.stop();
      await db.delete(schema.alertEvents);
      await db.delete(schema.webhooks);
    }
  });
});
