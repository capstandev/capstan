// Spread routes behind the real owner_sig gate: the signed caller must be the plan's owner (or an active agent of
// that owner). Another owner's valid signature is refused with 401 UNAUTHORIZED on POST /spreads/{id}/events and
// GET /spreads/{id}, and writes nothing; a plan cannot be drafted for someone else. Before this fix any valid
// signature could post events to, and read, any plan.
import { describe, expect, test } from "bun:test";
import { capstanMessage, memoryNonceStore } from "@capstan/core";
import type { Hex, SpreadPlan } from "@capstan/schema";
import { ACK_TEXT, memoryPlanStore } from "@capstan/spreads";
import { hashMessage } from "viem";
import { signDigestRsv } from "../../../packages/sdk/src/keys/secp";
import { NOW, setup } from "../../../packages/spreads/test/scan/helpers";
import { ownerSigVerifier } from "../src/auth";
import { createSpreadRoutes, type SpreadRouteDeps } from "../src/routes/spreads.routes";
import { addr, gwKey, HOST, signed, smallApp } from "./gw-helpers";

const ownerSk = gwKey("spread plan owner");
const agentSk = gwKey("spread plan agent");
const otherSk = gwKey("another spread owner");
const OWNER = addr(ownerSk);
const AGENT = addr(agentSk);
const T = NOW.getTime();

describe("spread routes: caller is the plan owner", () => {
  test("another-owner-refused", async () => {
    const s = setup();
    const store = memoryPlanStore();
    const receipts: string[] = [];
    const agentsOf = async (o: Hex) => (o.toLowerCase() === OWNER ? [AGENT] : []);
    const deps: SpreadRouteDeps = {
      planDeps: { ...s.deps, store },
      store,
      events: { receipts: { issue: async (a) => (receipts.push(a), { receiptId: `r${receipts.length}` }) }, venueFill: async () => null },
      nonces: memoryNonceStore(),
      host: HOST,
      agentsOf,
      now: () => T,
    };
    const verifier = ownerSigVerifier({ nonces: memoryNonceStore(), host: HOST, now: () => T, agentsOf: async (o) => (await agentsOf(o)).map((a) => ({ address: a, agentRef: `hl:${a}` })) });
    const { app } = await smallApp(createSpreadRoutes(() => deps), { verifiers: { owner_sig: verifier } });
    const call = (sk: Uint8Array, method: "GET" | "POST", path: string, body?: unknown, owner?: Hex) => {
      const raw = body === undefined ? "" : JSON.stringify(body);
      const headers = { ...signed(sk, { method, path: `/v1${path}`, body: raw, ts: T, ...(owner ? { owner } : {}) }), ...(raw ? { "content-type": "application/json" } : {}) };
      return app.request(`/v1${path}`, { method, headers, ...(raw ? { body: raw } : {}) });
    };
    const planBody = { owner: OWNER, equivalenceId: "eq-eth", sizeBase: "1", leverage: 3, hedgeFailurePolicy: "flatten_leg_a" };

    // a plan cannot be drafted for another owner
    expect((await call(otherSk, "POST", "/spreads/plan", planBody)).status).toBe(401);
    const res = await call(ownerSk, "POST", "/spreads/plan", planBody);
    expect(res.status).toBe(200);
    const p = (await res.json()) as SpreadPlan;
    const message = capstanMessage({ purpose: "spread_ack", owner: OWNER, host: HOST, chainId: 4663, nonce: "ack-owner-check-1", issuedAt: T - 1000, expiresAt: T + 600_000, body: ACK_TEXT(p.planId) });
    const ack = await app.request(`/v1/spreads/${p.planId}/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sig: signDigestRsv(hashMessage(message), ownerSk), message }) });
    expect(ack.status).toBe(200);

    // another owner's valid signature: refused, nothing written, nothing read
    const sent = { kind: "leg_a_sent", data: { buildId: "b1", venueOrderId: "1" } };
    const foreignEvent = await call(otherSk, "POST", `/spreads/${p.planId}/events`, sent);
    expect(foreignEvent.status).toBe(401);
    expect(((await foreignEvent.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
    expect(await store.list(p.planId)).toEqual([]);
    expect(receipts).toEqual([]);
    const foreignRead = await call(otherSk, "GET", `/spreads/${p.planId}`);
    expect(foreignRead.status).toBe(401);
    expect(((await foreignRead.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");

    // the owner and the owner's active agent are served
    expect((await call(ownerSk, "POST", `/spreads/${p.planId}/events`, sent)).status).toBe(200);
    expect((await call(agentSk, "POST", `/spreads/${p.planId}/events`, { kind: "leg_a_filled", data: { buildId: "b1", venueOrderId: "1", filled: "1" } }, OWNER)).status).toBe(200);
    const mine = await call(ownerSk, "GET", `/spreads/${p.planId}`);
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { events: { kind: string }[] }).events.map((e) => e.kind)).toEqual(["leg_a_sent", "leg_a_filled"]);
    expect((await call(agentSk, "GET", `/spreads/${p.planId}`, undefined, OWNER)).status).toBe(200);
    // an unknown plan is still 404 for a signed caller
    expect((await call(ownerSk, "GET", "/spreads/unknown")).status).toBe(404);
  });
});
