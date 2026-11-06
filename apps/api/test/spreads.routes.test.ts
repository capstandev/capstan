// Todo 21 routes: plan (draft, ack required), ack (spread_ack signature only), events (state machine, receipts,
// cross-check) and GET plan + events; each publishes on PUBSUB.plan(id).
import { describe, expect, test } from "bun:test";
import { capstanMessage, memoryNonceStore, PUBSUB } from "@capstan/core";
import { ACK_TEXT, memoryPlanStore } from "@capstan/spreads";
import type { SpreadPlan } from "@capstan/schema";
import { Hono } from "hono";
import { testWallet } from "../../../packages/policy/test/accounts";
import { NOW, setup } from "../../../packages/spreads/test/scan/helpers";
import { createSpreadRoutes, type SpreadRouteDeps } from "../src/routes/spreads.routes";

const owner = testWallet("spread route owner");
const HOST = "api.capstan.test";

describe("spread routes", () => {
  test("plan, ack, events, get", async () => {
    const s = setup();
    const store = memoryPlanStore();
    const published: string[] = [];
    const receipts: string[] = [];
    const deps: SpreadRouteDeps = {
      planDeps: { ...s.deps, store },
      store,
      events: { receipts: { issue: async (a) => (receipts.push(a), { receiptId: `r${receipts.length}` }) }, venueFill: async () => null },
      nonces: memoryNonceStore(),
      host: HOST,
      agentsOf: async () => [],
      publish: async (c) => void published.push(c),
      now: () => NOW.getTime(),
    };
    const h = new Hono();
    // stand-in for the owner_sig gate (spreads-owner.test.ts runs the real one): the signature was for this owner
    h.use("*", async (c, next) => {
      (c as unknown as { set(k: string, v: unknown): void }).set("owner", owner.address.toLowerCase());
      await next();
    });
    for (const r of createSpreadRoutes(() => deps)) h.on(r.method, `/v1${r.path}`, (c) => r.handler(c));
    const post = (path: string, body: unknown) => h.request(`/v1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    // a proposed equivalence is refused; an approved one gives a draft
    expect((await post("/spreads/plan", { owner: owner.address, equivalenceId: "nope", sizeBase: "1", leverage: 3, hedgeFailurePolicy: "leave_open" })).status).toBe(403);
    const res = await post("/spreads/plan", { owner: owner.address, equivalenceId: "eq-eth", sizeBase: "1", leverage: 3, hedgeFailurePolicy: "flatten_leg_a", legTimeoutMs: 5000 });
    expect(res.status).toBe(200);
    const p = (await res.json()) as SpreadPlan;
    expect([p.status, p.riskLabel, p.ackRequired, p.legTimeoutMs]).toEqual(["draft", "At-risk. Legging risk is yours.", true, 5000]);
    // events before the ack are refused
    expect((await post(`/spreads/${p.planId}/events`, { kind: "leg_a_sent", data: {} })).status).toBe(409);
    // ack with the right text
    const message = capstanMessage({ purpose: "spread_ack", owner: owner.address, host: HOST, chainId: 4663, nonce: "ack-route-0001", issuedAt: NOW.getTime() - 1000, expiresAt: NOW.getTime() + 600_000, body: ACK_TEXT(p.planId) });
    expect((await post(`/spreads/${p.planId}/ack`, { sig: await testWallet("someone").signMessage({ message }), message })).status).toBe(401);
    const ok = await post(`/spreads/${p.planId}/ack`, { sig: await owner.signMessage({ message }), message });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "acked" });
    // the executor's events
    expect((await post(`/spreads/${p.planId}/events`, { kind: "leg_a_sent", data: { buildId: "b1", venueOrderId: "1" } })).status).toBe(200);
    expect((await post(`/spreads/${p.planId}/events`, { kind: "leg_a_filled", data: { buildId: "b1", venueOrderId: "1", filled: "1" } })).status).toBe(200);
    expect((await post(`/spreads/${p.planId}/events`, { kind: "flattened", data: { residualDeltaBase: "0" } })).status).toBe(200);
    expect(receipts).toEqual(["spread.leg", "spread.plan"]);
    const g = (await (await h.request(`/v1/spreads/${p.planId}`)).json()) as { plan: SpreadPlan; events: { kind: string }[] };
    expect(g.plan.status).toBe("flattened");
    expect(g.events.map((e) => e.kind)).toEqual(["leg_a_sent", "leg_a_filled", "flattened"]);
    expect(new Set(published)).toEqual(new Set([PUBSUB.plan(p.planId)]));
    expect((await h.request("/v1/spreads/unknown")).status).toBe(404);
  });
});
