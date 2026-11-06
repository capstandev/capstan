// R5 dedupe, R6 unhedged, R7 expiry 7 days and 1 day before, R11 policy breach once per agent per 10 minutes,
// R12 webhook registration signature purpose. Needs DATABASE_URL for the delivery parts.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { capstanMessage, memoryNonceStore, schema, type Db } from "@capstan/core";
import { eq } from "drizzle-orm";
import { dispatch, expiryAlerts, liqAlerts, liqDistanceRule, policyBreachAlert, registerBody, registerWebhook, removeBody, removeWebhook, unhedgedAlert, approvalExpiryRule, type DelegationRow } from "../../src/alerts";
import { runAlertsDispatch } from "../../src/jobs/alerts-dispatch.job";
import { testWallet } from "../../../../packages/policy/test/accounts";
import { addWebhook, derive, NOW, OWNER, PG, publicResolver, receiver, tempDb } from "./helpers";

const ladder = (distancePct: number | null, marketId = "hyperliquid:-:ETH") => ({ liquidationLadder: [{ marketId, venue: "hyperliquid" as const, liqPx: "1900", distancePct, liqPxSource: "venue" as const, markPx: "2000", side: "long" as const }] });
const dg = (id: string, expiresAt: Date | null, state = "active"): DelegationRow => ({ id, venue: "hyperliquid", owner: OWNER, accountIndex: null, agentAddress: "0x0000000000000000000000000000000000000abc", apiKeyIndex: null, builderMaxBps: 3, expiresAt, state, createdAt: NOW });

describe("alert rules (pure)", () => {
  test("levels and texts", () => {
    expect(liqDistanceRule(ladder(4.2), 10)).toEqual([{ marketId: "hyperliquid:-:ETH", venue: "hyperliquid", distancePct: 4.2 }]);
    expect(liqDistanceRule(ladder(12), 10)).toEqual([]);
    expect(liqDistanceRule(ladder(null), 10)).toEqual([]);
    // the tightest level crossed is the one sent
    expect(liqAlerts(OWNER, ladder(8)).map((a) => (a.data as { level: number }).level)).toEqual([10]);
    expect(liqAlerts(OWNER, ladder(4)).map((a) => (a.data as { level: number }).level)).toEqual([5]);
    expect(liqAlerts(OWNER, ladder(11))).toEqual([]);
  });

  test("expiry", () => {
    const day = 86_400_000;
    const rows = [dg("in8d", new Date(NOW.getTime() + 8 * day)), dg("in6d", new Date(NOW.getTime() + 6 * day)), dg("in12h", new Date(NOW.getTime() + day / 2)), dg("past", new Date(NOW.getTime() - 1)), dg("none", null), dg("killed", new Date(NOW.getTime() + day), "killed")];
    expect(approvalExpiryRule(rows, NOW).map((r) => r.id)).toEqual(["in6d", "in12h"]);
    const a = expiryAlerts(rows, NOW);
    expect(a.map((x) => [(x.data as { agentRef: string }).agentRef, (x.data as { level: string }).level, x.dedupeKey])).toEqual([
      ["in6d", "7d", "exp:in6d:7d"],
      ["in12h", "1d", "exp:in12h:1d"],
    ]);
    // the 7-day alert at exactly 7 days, the 1-day alert at exactly 1 day
    expect((expiryAlerts([dg("x", new Date(NOW.getTime() + 7 * day))], NOW)[0]!.data as { level: string }).level).toBe("7d");
    expect((expiryAlerts([dg("x", new Date(NOW.getTime() + day))], NOW)[0]!.data as { level: string }).level).toBe("1d");
  });
});

const d = PG ? describe : describe.skip;
d("alert rules with delivery", () => {
  let t: Awaited<ReturnType<typeof tempDb>>;
  let db: Db;
  let clock = NOW.getTime();
  beforeAll(async () => {
    t = await tempDb();
    db = t.db;
  }, 60_000);
  afterAll(async () => t?.drop(), 60_000);
  const deps = (r: ReturnType<typeof receiver>) => ({ db, now: () => new Date(clock), secretOf: derive, resolver: publicResolver, sleep: async () => {}, http: r.transport });
  const clean = async () => {
    await db.delete(schema.alertEvents);
    await db.delete(schema.webhooks);
  };
  beforeEach(async () => db && clean());

  test("dedupe", async () => {
    await addWebhook(db, "wh-d");
    const r = receiver();
    try {
      clock = NOW.getTime();
      const send = async (pct: number) => {
        let n = 0;
        for (const a of liqAlerts(OWNER, ladder(pct))) n += await dispatch(a, deps(r));
        return n;
      };
      expect(await send(8)).toBe(1); // level 10
      clock += 60_000;
      expect(await send(7.5)).toBe(0); // same level, same position, within 30 minutes
      clock += 60_000;
      expect(await send(4)).toBe(1); // a new level
      clock += 27 * 60_000;
      expect(await send(9)).toBe(0); // minute 29: level 10 still within 30 minutes of the first
      clock += 2 * 60_000;
      expect(await send(9)).toBe(1); // minute 31: the window has passed
      // another position is its own key
      expect(await send.call(null, 9).then(async () => {
        let n = 0;
        for (const a of liqAlerts(OWNER, ladder(9, "hyperliquid:-:BTC"))) n += await dispatch(a, deps(r));
        return n;
      })).toBe(1);
    } finally {
      r.stop();
    }
    const rows = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.webhookId, "wh-d"));
    expect(rows.length).toBe(4);
    await clean();
  });

  test("unhedged", async () => {
    await addWebhook(db, "wh-u");
    const r = receiver();
    try {
      clock = NOW.getTime();
      const work = { source: "plan" as const, owner: OWNER, planId: "PLAN42", kind: "unhedged", data: { residualDeltaBase: "0.37", reason: "leg B filled only partly" } };
      expect(await runAlertsDispatch(work, deps(r))).toEqual({ alerts: 1, delivered: 1 });
      clock += 3_600_000;
      expect(await runAlertsDispatch(work, deps(r))).toEqual({ alerts: 1, delivered: 0 }); // exactly one per plan
      expect(await runAlertsDispatch({ ...work, kind: "complete" }, deps(r))).toEqual({ alerts: 0, delivered: 0 });
      const body = JSON.parse(r.got[0]!.body);
      expect(body).toMatchObject({ kind: "plan_unhedged", data: { planId: "PLAN42", residualDeltaBase: "0.37" } });
      expect(body.data.text).toContain("0.37");
    } finally {
      r.stop();
      await clean();
    }
  });

  test("policy-breach", async () => {
    await addWebhook(db, "wh-p", { kinds: ["policy_breach"] });
    await addWebhook(db, "wh-other", { kinds: ["liq_distance"] }); // did not ask for this kind
    const r = receiver();
    try {
      clock = NOW.getTime();
      const w = { source: "policy_breach" as const, owner: OWNER, agentRef: "hl:0xabc", field: "maxNotionalPerOrderUsd" };
      expect((await runAlertsDispatch(w, deps(r))).delivered).toBe(1);
      clock += 5 * 60_000;
      expect((await runAlertsDispatch({ ...w, field: "maxLeverage" }, deps(r))).delivered).toBe(0); // same agent within 10 minutes
      expect((await runAlertsDispatch({ ...w, agentRef: "hl:0xdef" }, deps(r))).delivered).toBe(1); // another agent
      clock += 6 * 60_000;
      expect((await runAlertsDispatch(w, deps(r))).delivered).toBe(1); // 11 minutes later
      const first = JSON.parse(r.got[0]!.body);
      expect(first.data.field).toBe("maxNotionalPerOrderUsd");
      expect(first.data.text).toContain("maxNotionalPerOrderUsd");
      expect(r.got.length).toBe(3);
    } finally {
      r.stop();
      await clean();
    }
    expect(policyBreachAlert({ owner: OWNER, agentRef: "a", field: "mode" }).dedupeWindowMs).toBe(600_000);
    expect(unhedgedAlert({ planId: "p", owner: OWNER, kind: "flattened", data: {} })).toBeNull();
  });

  test("webhook-sig-purpose", async () => {
    const owner = testWallet("webhook owner");
    const nonces = memoryNonceStore();
    const url = "https://hooks.example.com/mine";
    const kinds = ["liq_distance", "plan_unhedged"] as const;
    let k = 0;
    const sign = async (purpose: "webhook_register" | "read" | "kill" | "api_request", body: string, w = owner) => {
      const message = capstanMessage({ purpose, owner: owner.address, host: "api.capstan.test", chainId: 4663, nonce: `wh-nonce-${k++}`, issuedAt: NOW.getTime() - 1000, expiresAt: NOW.getTime() + 60_000, body });
      return { message, sig: await w.signMessage({ message }) };
    };
    const opts = (message: string) => ({ message, host: "api.capstan.test", nowMs: NOW.getTime(), nonces, deriveSecret: derive, resolver: publicResolver });
    // any other purpose is refused, even with the right body
    for (const p of ["read", "kill", "api_request"] as const) {
      const m = await sign(p, registerBody(url, [...kinds]));
      await expect(registerWebhook(db, owner.address, url, [...kinds], m.sig, opts(m.message))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    // the body binds the URL and the kinds
    let m = await sign("webhook_register", registerBody("https://hooks.example.com/other", [...kinds]));
    await expect(registerWebhook(db, owner.address, url, [...kinds], m.sig, opts(m.message))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    m = await sign("webhook_register", registerBody(url, ["liq_distance"]));
    await expect(registerWebhook(db, owner.address, url, [...kinds], m.sig, opts(m.message))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // another signer
    m = await sign("webhook_register", registerBody(url, [...kinds]), testWallet("not the owner"));
    await expect(registerWebhook(db, owner.address, url, [...kinds], m.sig, opts(m.message))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // the right one: the signing value is returned once, only its hash is stored
    m = await sign("webhook_register", registerBody(url, [...kinds]));
    const r = await registerWebhook(db, owner.address, url, [...kinds], m.sig, opts(m.message));
    expect(r.secret).toBe(derive(r.id));
    const [row] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, r.id));
    expect(JSON.stringify(row)).not.toContain(r.secret);
    // a private URL is refused even when signed
    const priv = "https://169.254.169.254/latest";
    m = await sign("webhook_register", registerBody(priv, ["liq_distance"]));
    await expect(registerWebhook(db, owner.address, priv, ["liq_distance"], m.sig, opts(m.message))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // removal needs its own signed body
    m = await sign("webhook_register", registerBody(url, [...kinds]));
    await expect(removeWebhook(db, owner.address, r.id, m.sig, { message: m.message, host: "api.capstan.test", nowMs: NOW.getTime(), nonces })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    m = await sign("webhook_register", removeBody(r.id));
    await removeWebhook(db, owner.address, r.id, m.sig, { message: m.message, host: "api.capstan.test", nowMs: NOW.getTime(), nonces });
    const [gone] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, r.id));
    expect(gone!.disabled).toBe(true);
    await clean();
  });
});
