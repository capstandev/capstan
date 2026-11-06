// The SDK side: executeSpreadPlan fetches the plan, builds through the client's checked build path, submits through
// signAndSubmit and posts every step to /v1/spreads/{id}/events.
import { describe, expect, test } from "bun:test";
import type { OrderIntent, VenueId } from "@capstan/schema";
import { executeSpreadPlan, SPREAD_ACK_TEXT } from "../../../sdk/src/spreads";
import { ACK_TEXT } from "../../src";
import { planOf } from "./sim";

describe("sdk spread helpers", () => {
  test("executeSpreadPlan posts every step", async () => {
    expect(SPREAD_ACK_TEXT("P1")).toBe(ACK_TEXT("P1"));
    const p = planOf({ hedgeFailurePolicy: "flatten_leg_a" });
    const posted: { path: string; body: { kind: string } }[] = [];
    const built: [OrderIntent, VenueId, string][] = [];
    let n = 0;
    const client = {
      async buildOrder(intent: OrderIntent, venue: VenueId, mode: "relay" | "direct") {
        built.push([intent, venue, mode]);
        const buildId = `b${++n}`;
        return { build: { buildId, venue, preview: { reduceOnly: intent.reduceOnly } } as never, intent, venue, mode, agentRef: "a", digest: "0x00", checkedAt: 0 } as never;
      },
      signer: { sign: async (b: { buildId: string; venue: VenueId }) => ({ buildId: b.buildId, venue: b.venue, encoding: "hl_l1_action", signedBody: {}, signature: "0x00", signerRef: "a", payloadHash: "0x00" }) as never },
      async signAndSubmit(cb: { venue: VenueId; build: { buildId: string } }) {
        const reject = cb.venue === p.legB.venue;
        return { order: { venue: cb.venue, marketId: "", venueOrderId: reject ? "" : `o-${cb.build.buildId}`, side: "buy", size: "1", filled: "0", px: null, status: reject ? "rejected" : "open", builderFeeBps: 0, createdAt: "" }, receiptId: "r" } as never;
      },
    };
    const api = {
      get: async <T>(path: string) => (expect(path).toBe(`/spreads/${p.planId}`), { plan: p } as T),
      post: async <T>(path: string, body: unknown) => (posted.push({ path, body: body as { kind: string } }), {} as T),
    };
    let clock = 0;
    const r = await executeSpreadPlan(p.planId, client as never, api, { fillOf: async () => ({ filled: "1", avgPx: "2000", done: true }), now: () => clock, sleep: async (ms) => void (clock += ms) });
    expect(r.status).toBe("flattened");
    expect(new Set(posted.map((x) => x.path))).toEqual(new Set([`/spreads/${p.planId}/events`]));
    expect(posted.map((x) => x.body.kind)).toEqual(["leg_a_sent", "leg_a_filled", "leg_b_sent", "flattened"]); // B was sent and rejected
    // relay mode by default; the flatten is reduce-only on leg A
    expect(built.map(([i, v, m]) => [v, i.reduceOnly, m])).toEqual([[p.legA.venue, false, "relay"], [p.legB.venue, false, "relay"], [p.legA.venue, true, "relay"]]);
  });
});
