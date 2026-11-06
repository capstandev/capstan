// R3 to R6 (todo 15): exact query on the wire, 503 never resubmitted, -4225 and -5050 mapped.
import { CapstanError } from "@capstan/schema";
import { AsterNonce } from "@capstan/signer-aster";
import { describe, expect, test } from "bun:test";
import { withFreshNonce, type AsterOrderPayload } from "../../src/orders";
import { buildOrderStatusRead } from "../../src/signedread";
import { json } from "../helpers";
import { agent, ctx, intent, NOW, setup, sign } from "./setup";

function capture() {
  const seen: { method: string; query: string; body: string; type: string | null }[] = [];
  return {
    seen,
    route: (answer: () => Response) => async (r: Request) => {
      seen.push({ method: r.method, query: new URL(r.url).search.slice(1), body: await r.text(), type: r.headers.get("content-type") });
      return answer();
    },
  };
}

describe("aster submit", () => {
  test("exact-query", async () => {
    const c = capture();
    const s = setup({ "/fapi/v3/order": c.route(() => json({ orderId: 12345678901234567890n.toString(), status: "NEW" })) });
    try {
      const b = await s.adapter.buildOrder(intent(), ctx());
      const env = await sign(b);
      const r = await s.adapter.submit(env);
      expect(c.seen.length).toBe(1);
      expect(c.seen[0]!.method).toBe("POST");
      // the signed string, then &signature=, byte for byte; the body is empty
      expect(c.seen[0]!.query).toBe(`${env.signedBody}&signature=${env.signature}`);
      expect(c.seen[0]!.body).toBe("");
      expect(c.seen[0]!.type).toBe("application/x-www-form-urlencoded");
      expect(r).toMatchObject({ status: "accepted", venueOrderId: "12345678901234567890" });
      // a cancel goes out as DELETE
      const cb = await s.adapter.buildCancel({ marketId: "aster:-:BTCUSDT", venueOrderId: "42" }, ctx());
      await s.adapter.submit(await sign(cb));
      expect(c.seen[1]!.method).toBe("DELETE");
    } finally {
      s.stop();
    }
  });

  test("503-no-resubmit", async () => {
    const c = capture();
    const s = setup({ "/fapi/v3/order": c.route(() => new Response("", { status: 503 })) });
    try {
      const b = await s.adapter.buildOrder(intent({ clientOrderId: "cp-503" }), ctx());
      const env = await sign(b);
      const r = await s.adapter.submit(env);
      expect(r.status).toBe("unknown");
      expect(r.message).toContain("newClientOrderId");
      expect(c.seen.length).toBe(1);
      // the same payload is never sent again
      const again = await s.adapter.submit(env).catch((e: CapstanError) => e.code);
      expect(again).toBe("DUPLICATE_PAYLOAD");
      expect(c.seen.length).toBe(1);
      // the SDK reconciles with a signed order read by the client id the build set
      const read = buildOrderStatusRead(agent.address, agent.address, BigInt(NOW) * 1000n, "Mainnet", "BTCUSDT", (b.payload as AsterOrderPayload).clientOrderId!);
      expect(read.path).toBe("/fapi/v3/order");
      expect(read.query.startsWith("symbol=BTCUSDT&origClientOrderId=cp-503&asterChain=Mainnet")).toBe(true);
    } finally {
      s.stop();
    }
  });

  test("nonce-expired", async () => {
    const c = capture();
    const s = setup({ "/fapi/v3/order": c.route(() => json({ code: -4225, msg: "Nonce Expired" }, 400)) });
    try {
      const b = await s.adapter.buildOrder(intent(), ctx());
      const r = await s.adapter.submit(await sign(b));
      expect(r).toMatchObject({ status: "rejected", code: "ASTER_NONCE_EXPIRED" });
      expect(c.seen.length).toBe(1); // the relay holds no key: it cannot re-sign, it reports
      // the SDK path: a fresh nonce, a new digest, signed again by the agent, verifies
      const fresh = withFreshNonce(b, new AsterNonce(), NOW + 120_000);
      const nonceOf = (x: typeof b) => Number((x.payload as AsterOrderPayload).params.find(([k]) => k === "nonce")![1]);
      expect(nonceOf(fresh)).toBeGreaterThan(nonceOf(b));
      expect(fresh.digest).not.toBe(b.digest);
      const env2 = await sign(fresh);
      const { verifyAsterSigned } = await import("../../src/verify");
      expect(verifyAsterSigned(env2, fresh, NOW + 120_000)).toEqual({ ok: true });
    } finally {
      s.stop();
    }
  });

  test("deposit-required", async () => {
    const s = setup({ "/fapi/v3/order": () => json({ code: -5050, msg: "This function can only be used after deposit" }, 400) });
    try {
      const b = await s.adapter.buildOrder(intent(), ctx());
      expect(await s.adapter.submit(await sign(b))).toMatchObject({ status: "rejected", code: "ASTER_DEPOSIT_REQUIRED" });
    } finally {
      s.stop();
    }
  });
});
