// R9: submit never retries, maps venue errors, and a builder refusal is never resent without the field.
import { describe, expect, test } from "bun:test";
import { createMemoryGovernor, fakeVenueServer, venueHttp } from "@capstan/venue-client";
import { buildOrder, submit } from "../../src";
import { book, ctx, setup, sign, T0 } from "./util";

async function envelope() {
  const { deps, cache } = setup();
  await cache.putBook(book("hyperliquid:-:BTC", 76000, T0));
  const b = await buildOrder({ marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "market", tif: "ioc", reduceOnly: false, maxSlippageBps: 50 }, ctx(), deps);
  return { b, env: sign(b) };
}

describe("submit", () => {
  test("no-retry-no-strip", async () => {
    const { env } = await envelope();
    const answers: Response[] = [];
    const bodies: unknown[] = [];
    const srv = fakeVenueServer({
      "POST /exchange": async (req) => {
        bodies.push(await req.json());
        return answers.shift() ?? Response.json({ status: "ok" });
      },
    });
    try {
      const http = venueHttp("hyperliquid", srv.url, createMemoryGovernor("t"), { backoffBaseMs: 1 });
      // 500: one POST only, outcome unknown
      answers.push(new Response("oops", { status: 500 }));
      const r1 = await submit(env, http);
      expect(srv.hits.filter((h) => h === "POST /exchange").length).toBe(1);
      expect(r1.status).toBe("unknown");
      // venue err text -> VENUE_ERROR with the text
      answers.push(Response.json({ status: "err", response: "Order has invalid size." }));
      const r2 = await submit(env, http);
      expect(r2).toMatchObject({ status: "rejected", code: "VENUE_ERROR", message: "Order has invalid size." });
      // builder refusal -> BUILDER_APPROVAL_REQUIRED, and nothing is resent
      answers.push(Response.json({ status: "err", response: "Builder fee has not been approved." }));
      const before = srv.hits.length;
      const r3 = await submit(env, http);
      expect(r3).toMatchObject({ status: "rejected", code: "BUILDER_APPROVAL_REQUIRED" });
      expect(srv.hits.length).toBe(before + 1);
      // per-order error inside an ok response
      answers.push(Response.json({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin to place order." }] } } }));
      expect(await submit(env, http)).toMatchObject({ status: "rejected", code: "VENUE_ERROR" });
      // accepted: resting and filled
      answers.push(Response.json({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 77738308 } }] } } }));
      expect(await submit(env, http)).toMatchObject({ status: "accepted", venueOrderId: "77738308" });
      answers.push(Response.json({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.001", avgPx: "76010.0", oid: 77738309 } }] } } }));
      expect(await submit(env, http)).toMatchObject({ status: "accepted", venueOrderId: "77738309" });
      // every POST carried the builder field exactly as signed
      for (const b of bodies) expect((b as any).action.builder).toEqual((env.signedBody as any).action.builder);
      expect(srv.hits.filter((h) => h === "POST /exchange").length).toBe(6);
    } finally {
      srv.stop();
    }
  });
});
