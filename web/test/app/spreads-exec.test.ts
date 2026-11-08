// R1-8-01 (security review round 1): the dashboard's spread executor must never treat an unread fill as a confirmed
// no-fill. It runs the dashboard's own execute path (defaultExecute: the SDK executor over this screen's fill port)
// against simulated venues that REALLY fill every order, and checks what the user would hold:
//   - leg B is never sent twice when the venue holds the first leg B order's fill;
//   - a plan reported 'failed' or 'flattened' leaves no open position on any market.
import { describe, expect, test } from "bun:test";
import type { SpreadPlan } from "../../src/lib/capstan";
import { defaultExecute } from "../../src/app/screens/Spreads";

const OWNER = "0x00000000000000000000000000000000000000a1";
const API = "http://api.test";
const HL = "http://hl.test";

interface Sent {
  venue: string;
  marketId: string;
  side: "buy" | "sell";
  size: number;
  reduceOnly: boolean;
  oid: number;
}

function planOf(a: { venue: string; marketId: string }, b: { venue: string; marketId: string }, policy: SpreadPlan["hedgeFailurePolicy"]): SpreadPlan {
  const leg = (x: { venue: string; marketId: string }, side: "buy" | "sell") => ({ ...x, side, size: "1", collateralAsset: "USDC", estLiqPx: null, payloadTemplate: { payload: { lotSize: "0.01" } } });
  return {
    planId: "PLANEXEC1",
    canonicalAsset: "CR:ETH",
    equivalenceId: "eq-eth",
    legA: leg(a, "sell"),
    legB: leg(b, "buy"),
    sizeBase: "1",
    residualDeltaBase: "0",
    fundingDiffPerHourBps: 0.8,
    roundTripCostBps: 13,
    breakevenHours: 16,
    nextSettlements: [],
    hedgeFailurePolicy: policy,
    maxLegSlippageBps: 50,
    legTimeoutMs: 300,
    riskLabel: "At-risk. Legging risk is yours.",
    ackRequired: true,
    status: "acked",
  } as unknown as SpreadPlan;
}

/** Venues that fill every order in full. Hyperliquid answers orderStatus (optionally 'unknownOid' for some orders). */
function venues(p: SpreadPlan, o: { hlUnknown?: (s: Sent) => boolean } = {}) {
  const sent: Sent[] = [];
  const events: { kind: string; data: unknown }[] = [];
  let oid = 1000;
  const client = {
    async buildOrder(intent: { marketId: string; side: "buy" | "sell"; size: string; reduceOnly: boolean }, venue: string) {
      return { build: { buildId: `b${sent.length}-${intent.marketId}`, venue, preview: {} }, intent, venue, mode: "relay" };
    },
    signer: { sign: async (b: { buildId: string; venue: string }) => ({ buildId: b.buildId, venue: b.venue, payloadHash: `0x${"0".repeat(64)}` }) },
    async signAndSubmit(cb: { venue: string; intent: { marketId: string; side: "buy" | "sell"; size: string; reduceOnly: boolean } }) {
      const s: Sent = { venue: cb.venue, marketId: cb.intent.marketId, side: cb.intent.side, size: Number(cb.intent.size), reduceOnly: cb.intent.reduceOnly, oid: ++oid };
      sent.push(s);
      // the relay passes the venue's order id through: Hyperliquid's numeric oid, Aster's orderId
      return { order: { venue: cb.venue, venueOrderId: String(s.oid), status: "open" }, receiptId: `r${s.oid}` };
    },
  };
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === API && url.pathname === `/v1/spreads/${p.planId}` && (init?.method ?? "GET") === "GET") return Response.json({ plan: p });
    if (url.origin === API && url.pathname === `/v1/spreads/${p.planId}/events`) {
      events.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    if (url.origin === HL && url.pathname === "/info") {
      const q = JSON.parse(String(init?.body)) as { type: string; oid: number };
      const s = sent.find((x) => x.oid === q.oid && x.venue === "hyperliquid");
      if (!s || o.hlUnknown?.(s)) return Response.json({ status: "unknownOid" });
      return Response.json({ status: "order", order: { order: { origSz: String(s.size), sz: "0", limitPx: "2000" }, status: "filled" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const session = { client, connected: { owner: OWNER }, cfg: { apiBase: API, fetch: f, venueHosts: { hyperliquid: HL } } };
  const position = (marketId: string) => sent.filter((x) => x.marketId === marketId).reduce((n, x) => n + (x.side === "buy" ? x.size : -x.size), 0);
  return { session, sent, events, position };
}

async function run(p: SpreadPlan, o?: Parameters<typeof venues>[1]) {
  const v = venues(p, o);
  const r = await defaultExecute(v.session as never)(p.planId, () => undefined);
  const legBOpens = v.sent.filter((x) => x.marketId === p.legB.marketId && !x.reduceOnly).length;
  return { status: r.status, legBOpens, a: v.position(p.legA.marketId), b: v.position(p.legB.marketId), sent: v.sent, events: v.events };
}

const ASTER = { venue: "aster", marketId: "aster:-:ETH" };
const HLCORE = { venue: "hyperliquid", marketId: "hyperliquid:-:ETH" };
const HIP3 = { venue: "hyperliquid", marketId: "hyperliquid:xyz:ETH" };

describe("spread executor on the dashboard (R1-8-01)", () => {
  test("an Aster leg A that really filled is never reported as a plain failure while the user holds it", async () => {
    const r = await run(planOf(ASTER, HLCORE, "flatten_leg_a"));
    if (r.status === "failed" || r.status === "flattened") {
      expect({ a: r.a, b: r.b }).toEqual({ a: 0, b: 0 });
    }
    expect(r.legBOpens).toBeLessThanOrEqual(1);
  }, 20_000);

  test("an Aster leg B that really filled is never sent again (retry_then_flatten)", async () => {
    const r = await run(planOf(HLCORE, ASTER, "retry_then_flatten"));
    expect(r.legBOpens).toBeLessThanOrEqual(1);
    if (r.status === "failed" || r.status === "flattened") {
      expect({ a: r.a, b: r.b }).toEqual({ a: 0, b: 0 });
    }
  }, 20_000);

  test("a Hyperliquid order the venue does not know yet (unknownOid) is not a confirmed no-fill", async () => {
    const p = planOf(HLCORE, HIP3, "retry_then_flatten");
    const r = await run(p, { hlUnknown: (s) => s.marketId === HIP3.marketId });
    expect(r.legBOpens).toBe(1);
    expect(r.status).not.toBe("flattened");
    expect(r.status).not.toBe("failed");
    // the closing event says the leg B state is unknown, so the user is told to check the venue
    const last = r.events.at(-1) as { kind: string; data: { stateUnknown?: string[] } };
    expect(last.kind).toBe("unhedged");
    expect(last.data.stateUnknown?.join(" ")).toMatch(/leg B not confirmed/);
  }, 20_000);

  test("both legs on Hyperliquid with readable fills still complete", async () => {
    const r = await run(planOf(HLCORE, HIP3, "flatten_leg_a"));
    expect(r.status).toBe("complete");
    expect(r.a + r.b).toBe(0);
    expect(r.legBOpens).toBe(1);
  }, 20_000);
});
