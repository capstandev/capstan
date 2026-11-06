// R1, R2, R3, R15, R19 (todo 30): each step refuses with its code and a refusal receipt; tampered envelopes never
// reach a venue; the venue receives the exact signed bytes; expired delegations are retired; breaches queue an alert.
import { afterAll, describe, expect, test } from "bun:test";
import { verifyReceiptSig } from "@capstan/receipts";
import type { SignedEnvelope } from "@capstan/schema";
import { createMemoryGovernor } from "@capstan/venue-client";
import { handleSubmit } from "../src/pipeline";
import { codeOf, HL_REF, NOW, policyFor, relayStack, USER_A } from "./helpers";

const IP = "203.0.113.10";
const stacks: ReturnType<typeof relayStack>[] = [];
const stack = (o?: Parameters<typeof relayStack>[0]) => {
  const s = relayStack(o);
  stacks.push(s);
  return s;
};
afterAll(() => stacks.forEach((s) => s.stop()));

function rng(n: number): () => number {
  let a = n >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("relay pipeline", () => {
  test("each-refusal-receipted", async () => {
    const s = stack();
    const submit = (b: { buildId: string }, env: SignedEnvelope, ip = IP) => codeOf(handleSubmit({ buildId: b.buildId, signedEnvelope: env }, { ip }, s.deps));
    const expectRefusal = async (r: Awaited<ReturnType<typeof codeOf>>, code: string) => {
      expect(r.code).toBe(code);
      expect(r.receiptId).toBeDefined();
      const rc = s.receipts.byId(r.receiptId!)!;
      expect(rc.action).toBe("refusal");
      expect(verifyReceiptSig(rc, [s.receipts.signer])).toBe(true);
      expect(rc.venueOrderId).toBeNull();
    };

    // BUILD_EXPIRED
    let h = await s.hl();
    s.store.builds.get(h.b.buildId)!.expiresAt = NOW - 1;
    await expectRefusal(await submit(h.b, h.env), "BUILD_EXPIRED");

    // RETIRED_AGENT
    h = await s.hl();
    s.store.delegations.get(HL_REF)!.state = "retired";
    await expectRefusal(await submit(h.b, h.env), "RETIRED_AGENT");
    s.store.delegations.get(HL_REF)!.state = "active";

    // AGENT_KILLED
    const killedRef = "hl:killed-agent";
    s.store.delegations.set(killedRef, { ...s.store.delegations.get(HL_REF)!, id: killedRef });
    h = await s.hl({}, { agentRef: killedRef });
    s.kill.markKilled(killedRef);
    await expectRefusal(await submit(h.b, h.env), "AGENT_KILLED");

    // PAYLOAD_MISMATCH (size changed after signing)
    h = await s.hl();
    const tampered = structuredClone(h.env) as SignedEnvelope & { signedBody: { action: { orders: { s: string }[] } } };
    tampered.signedBody.action.orders[0]!.s = "0.002";
    await expectRefusal(await submit(h.b, tampered), "PAYLOAD_MISMATCH");

    // POLICY_BREACH (notional above the per-order cap)
    const polRef = "hl:policy-agent";
    s.store.delegations.set(polRef, { ...s.store.delegations.get(HL_REF)!, id: polRef });
    s.policies.set(polRef, { policyId: "pol-1", policy: policyFor(polRef, { maxNotionalPerOrderUsd: "10" }) });
    h = await s.hl({ size: "0.01" }, { agentRef: polRef, policyId: "pol-1" });
    const pb = await submit(h.b, h.env);
    await expectRefusal(pb, "POLICY_BREACH");
    expect(pb.field).toBe("maxNotionalPerOrderUsd");

    // GEO_REFUSED and DECLARATION_MISSING from the eligibility re-check with the submit IP
    s.refusedIps.set("198.51.100.1", "GEO_REFUSED");
    s.refusedIps.set("198.51.100.2", "DECLARATION_MISSING");
    h = await s.hl();
    await expectRefusal(await submit(h.b, h.env, "198.51.100.1"), "GEO_REFUSED");
    expect(s.decisions.at(-1)!.ip).toBe("198.51.100.1");
    h = await s.hl();
    await expectRefusal(await submit(h.b, h.env, "198.51.100.2"), "DECLARATION_MISSING");

    // DUPLICATE_PAYLOAD
    h = await s.hl();
    expect((await submit(h.b, h.env)).code).toBeNull();
    await expectRefusal(await submit(h.b, h.env), "DUPLICATE_PAYLOAD");

    // VENUE_RATE_LIMITED (free lane, third order in a minute)
    s.laneOf.value = async () => ({ lane: "free", perMin: 2 });
    s.lanes.reset();
    for (let i = 0; i < 2; i++) {
      h = await s.hl();
      expect((await submit(h.b, h.env)).code).toBeNull();
    }
    h = await s.hl();
    await expectRefusal(await submit(h.b, h.env), "VENUE_RATE_LIMITED");
  });

  test("no-unmatched-forwarded", async () => {
    const s = stack({ governor: createMemoryGovernor("fuzz", { sleep: async () => undefined }) });
    s.laneOf.value = async () => ({ lane: "pro", perMin: 1_000_000 });
    s.deps.lanes = { take: async (o) => ({ ok: true, lane: o.lane }) };
    const r = rng(30);
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
    const mutateValue = (v: unknown): unknown => (typeof v === "number" ? v + 1 + Math.floor(r() * 9) : typeof v === "boolean" ? !v : typeof v === "string" ? (v.length ? v.slice(0, -1) + (v.endsWith("1") ? "2" : "1") : "x") : v === null ? 0 : { x: 1 });
    function tamperObject(o: Record<string, unknown>): void {
      const keys = Object.keys(o);
      const k = pick(keys);
      const v = o[k];
      if (v && typeof v === "object" && !Array.isArray(v) && r() < 0.6) return tamperObject(v as Record<string, unknown>);
      if (Array.isArray(v) && v.length && typeof v[0] === "object" && r() < 0.6) return tamperObject(v[0] as Record<string, unknown>);
      if (r() < 0.1) delete o[k];
      else if (r() < 0.1) o[`extra${Math.floor(r() * 9)}`] = 1;
      else o[k] = mutateValue(v);
    }
    let refused = 0;
    for (const venue of ["hyperliquid", "aster", "lighter-mainnet"] as const) {
      for (let i = 0; i < 500; i++) {
        const made = venue === "hyperliquid" ? await s.hl() : venue === "aster" ? s.aster() : s.lighter();
        const env = structuredClone(made.env) as SignedEnvelope;
        const mode = Math.floor(r() * 5);
        if (venue === "aster") {
          const q = String(env.signedBody).split("&");
          const j = Math.floor(r() * q.length);
          if (mode === 0) q.splice(j, 1);
          else if (mode === 1) q.push("reduceOnly=true");
          else if (mode === 2 && q.length > 1) [q[0], q[q.length - 1]] = [q[q.length - 1]!, q[0]!];
          else q[j] = `${q[j]}9`;
          env.signedBody = q.join("&");
          if (r() < 0.5) env.payloadHash = `0x${"00".repeat(32)}` as never; // a claimed hash never helps
        } else if (venue === "lighter-mainnet") {
          const body = env.signedBody as { txType: number; txInfo: string };
          const info = JSON.parse(body.txInfo) as Record<string, unknown>;
          if (mode === 0) body.txType = pick([12, 13, 15, 16]);
          else {
            tamperObject(info);
            body.txInfo = JSON.stringify(info);
          }
        } else {
          if (mode === 0) env.signature = `0x${"11".repeat(65)}`;
          else if (mode === 1) env.buildId = (s.store.builds.keys().next().value as string) ?? env.buildId;
          else tamperObject(env.signedBody as Record<string, unknown>);
        }
        const res = await codeOf(handleSubmit({ buildId: made.b.buildId, signedEnvelope: env }, { ip: IP }, s.deps));
        expect(res.code).not.toBeNull();
        refused++;
      }
    }
    expect(refused).toBe(1500);
    expect(s.venues.total()).toBe(0); // the fake venues received none of them
  });

  test("bytes-unchanged", async () => {
    const s = stack();
    const h = await s.hl();
    await handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: IP }, s.deps);
    expect(s.venues.hl[0]!.body).toBe(JSON.stringify(h.env.signedBody));
    const a = s.aster();
    await handleSubmit({ buildId: a.b.buildId, signedEnvelope: a.env }, { ip: IP }, s.deps);
    expect(s.venues.aster[0]!.path).toBe(`/fapi/v3/order?${a.env.signedBody as string}&signature=${a.env.signature}`);
    const l = s.lighter();
    await handleSubmit({ buildId: l.b.buildId, signedEnvelope: l.env }, { ip: IP }, s.deps);
    const form = new URLSearchParams(s.venues.lighter[0]!.body);
    expect(form.get("tx_info")).toBe((l.env.signedBody as { txInfo: string }).txInfo);
    expect(form.get("tx_type")).toBe("14");
  });

  test("expired-delegation", async () => {
    const s = stack();
    s.store.delegations.get(HL_REF)!.expiresAt = NOW - 1; // HL valid_until passed
    const h = await s.hl();
    const r = await codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: IP }, s.deps));
    expect(r.code).toBe("RETIRED_AGENT");
    expect(s.receipts.byId(r.receiptId!)!.action).toBe("refusal");
    // Aster `expired` works the same way through the delegation row
    s.store.delegations.get(HL_REF)!.expiresAt = null;
    const a = s.aster();
    const asterRef = s.store.builds.get(a.b.buildId)!.agentRef!;
    s.store.delegations.get(asterRef)!.expiresAt = NOW;
    expect((await codeOf(handleSubmit({ buildId: a.b.buildId, signedEnvelope: a.env }, { ip: IP }, s.deps))).code).toBe("RETIRED_AGENT");
    expect(s.venues.total()).toBe(0);
  });

  test("breach-alert-enqueued", async () => {
    const s = stack();
    const ref = "hl:breach-agent";
    s.store.delegations.set(ref, { ...s.store.delegations.get(HL_REF)!, id: ref });
    s.policies.set(ref, { policyId: "pol-b", policy: policyFor(ref, { allowedMarkets: ["hyperliquid:-:ETH"] }) });
    for (let i = 0; i < 3; i++) {
      const h = await s.hl({}, { agentRef: ref, policyId: "pol-b" });
      const r = await codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: IP }, s.deps));
      expect(r.code).toBe("POLICY_BREACH");
      expect(s.breaches.length).toBe(i + 1); // exactly one alert job per refusal
      expect(s.breaches.at(-1)).toMatchObject({ owner: USER_A, agentRef: ref, field: "allowedMarkets", buildId: h.b.buildId });
    }
    // an allowed order queues nothing
    const h = await s.hl();
    await handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: IP }, s.deps);
    expect(s.breaches.length).toBe(3);
  });
});
