// Relay arming (DEP-6): RELAY_SUBMIT_ARMED is off unless set, an unarmed relay never sends to a venue, and GET /health
// reports relayEnabled, submitArmed and submitting separately, so "enabled" never reads as "submitting".
import { afterAll, describe, expect, test } from "bun:test";
import { relayFlags } from "../src/flags";
import { relayHealth, relayHttp } from "../src/health";
import { handleSubmit, RELAY_NOT_ARMED } from "../src/pipeline";
import { codeOf, relayStack } from "./helpers";

const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));

describe("relay arming", () => {
  test("health-reports-armed-separately: enabled but not armed is not submitting", async () => {
    const unarmed = relayFlags({ RELAY_ENABLED: "1", RELAY_SUBMIT_ARMED: "0" });
    expect(relayHealth(unarmed)).toEqual({ ok: true, service: "relay", relayEnabled: true, submitArmed: false, submitting: false });
    // unset means not armed (the VPS relay.env ships RELAY_SUBMIT_ARMED=0)
    expect(relayHealth(relayFlags({})).submitArmed).toBe(false);
    const armed = relayFlags({ RELAY_SUBMIT_ARMED: "1" });
    expect(relayHealth(armed)).toEqual({ ok: true, service: "relay", relayEnabled: true, submitArmed: true, submitting: true });
    armed.set("RELAY_ENABLED", false, "ops-oncall");
    expect(relayHealth(armed)).toEqual({ ok: true, service: "relay", relayEnabled: false, submitArmed: true, submitting: false });
    // the HTTP surface serves the same body
    const res = relayHttp(unarmed)(new Request("http://127.0.0.1/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(relayHealth(unarmed));
    expect(relayHttp(unarmed)(new Request("http://127.0.0.1/other")).status).toBe(404);
  });

  test("unarmed-never-submits: an unarmed relay refuses before the venue, and the same envelope goes through once armed", async () => {
    const s = relayStack();
    stacks.push(s);
    s.deps.flags = relayFlags({});
    const ip = { ip: "203.0.113.81" };
    const h = await s.hl();
    const r = await codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, ip, s.deps));
    expect(r.code).toBe("VENUE_ERROR");
    expect(r.message).toBe(RELAY_NOT_ARMED);
    expect(s.receipts.byId(r.receiptId!)!.action).toBe("refusal");
    expect(s.venues.total()).toBe(0);
    s.deps.flags = relayFlags({ RELAY_SUBMIT_ARMED: "1" });
    expect((await codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, ip, s.deps))).code).toBeNull();
    expect(s.venues.hl.length).toBe(1);
  });
});
