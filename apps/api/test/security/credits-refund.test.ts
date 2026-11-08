// r1:3 F8: credits were debited in the auth gate before the rate limiter, validation and handler, so a 429, 400 or
// 404 still cost the credit, and credits could pay the top-up route itself (the user lost the pack and got nothing).
// Now a credit spend is refunded when the answer is not 2xx, and a top-up is never paid from credits.
import { describe, expect, test } from "bun:test";
import type { RouteSpec } from "@capstan/core";
import { errorBody } from "@capstan/schema";
import type { MiddlewareHandler } from "hono";
import { apiKeyCheck, x402Verifier } from "../../src/auth";
import { smallApp } from "../gw-helpers";

function harness(opts: { limit?: boolean } = {}) {
  let balance = 10;
  const spends: string[] = [];
  const refunds: string[] = [];
  const check = apiKeyCheck({ verify: async (k) => (k === "cpst_credited" ? { id: "acct-1", ownerWallet: null, tier: "payg" } : null) });
  const routes: RouteSpec[] = [
    { method: "GET", path: "/funding/forecast", auth: "x402", priced: { usd: "1" }, description: "forecast", handler: (c) => (c.req.query("bad") ? c.json(errorBody("INVALID_INPUT"), 400) : c.req.query("missing") ? c.json(errorBody("NOT_FOUND"), 404) : c.req.query("boom") ? Promise.reject(new Error("boom")) : c.json({ ok: true })) },
    { method: "POST", path: "/credits/topup/5", auth: "x402", priced: { usd: "5" }, description: "topup", handler: (c) => c.json({ status: "credited when the payment settles" }, 202) },
  ];
  const limit: MiddlewareHandler = async (c, next) => (opts.limit ? c.json(errorBody("VENUE_RATE_LIMITED"), 429) : next());
  const limiter = (_s: RouteSpec): MiddlewareHandler => limit;
  const payment: MiddlewareHandler = async (c) => c.json(errorBody("X402_PAYMENT_REQUIRED"), 402);
  const verifier = x402Verifier({
    check,
    spend: async (_id, route, usd) => (Number(usd) <= balance ? ((balance -= Number(usd)), spends.push(route), true) : false),
    refund: async (_id, route, usd) => {
      balance += Number(usd);
      refunds.push(route);
    },
  });
  return { make: () => smallApp(routes, { verifiers: { x402: verifier }, limiter, payment }), balance: () => balance, spends, refunds };
}
const auth = { headers: { authorization: "Bearer cpst_credited" } };

describe("credit spends are refunded on a refusal (r1:3 F8)", () => {
  test("a 2xx keeps the spend", async () => {
    const h = harness();
    const { app } = await h.make();
    expect((await app.request("/v1/funding/forecast", auth)).status).toBe(200);
    expect(h.balance()).toBe(9);
    expect(h.refunds).toEqual([]);
  });
  test("a 400, a 404 and a 500 leave the balance unchanged", async () => {
    const h = harness();
    const { app } = await h.make();
    expect((await app.request("/v1/funding/forecast?bad=1", auth)).status).toBe(400);
    expect((await app.request("/v1/funding/forecast?missing=1", auth)).status).toBe(404);
    expect((await app.request("/v1/funding/forecast?boom=1", auth)).status).toBe(500);
    expect(h.balance()).toBe(10);
    expect(h.refunds.length).toBe(3);
  });
  test("a 429 from the rate limiter leaves the balance unchanged", async () => {
    const h = harness({ limit: true });
    const { app } = await h.make();
    expect((await app.request("/v1/funding/forecast", auth)).status).toBe(429);
    expect(h.balance()).toBe(10);
  });
  test("credits never pay a top-up: it goes to the x402 gate", async () => {
    const h = harness();
    const { app } = await h.make();
    const r = await app.request("/v1/credits/topup/5?account=acct-1", { method: "POST", ...auth });
    expect(r.status).toBe(402);
    expect(h.spends).toEqual([]);
    expect(h.balance()).toBe(10);
  });
});
