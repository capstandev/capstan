// R12 (todo 30): RELAY_ENABLED=0 (or a venue flag off) refuses with "relay paused"; turning it back on resumes; both
// changes are logged with the operator and the time.
import { afterAll, describe, expect, test } from "bun:test";
import { relayFlags } from "../src/flags";
import { handleSubmit, RELAY_PAUSED } from "../src/pipeline";
import { codeOf, NOW, relayStack } from "./helpers";

const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));

describe("ops relay stop", () => {
  test("relay-stop-restart", async () => {
    const s = relayStack();
    stacks.push(s);
    const logged: unknown[] = [];
    const flags = relayFlags({ RELAY_SUBMIT_ARMED: "1" }, { now: () => NOW, log: (c) => logged.push(c) });
    s.deps.flags = flags;
    const ip = { ip: "203.0.113.80" };
    const stop = flags.set("RELAY_ENABLED", false, "ops-oncall");
    let h = await s.hl();
    const r = await codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, ip, s.deps));
    expect(r.code).toBe("VENUE_ERROR");
    expect(r.message).toBe(RELAY_PAUSED);
    expect(s.receipts.byId(r.receiptId!)!.action).toBe("refusal");
    expect(s.venues.total()).toBe(0);
    const start = flags.set("RELAY_ENABLED", true, "ops-oncall");
    // the paused payload was not consumed: the same signed envelope goes through after the restart
    expect((await codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, ip, s.deps))).code).toBeNull();
    expect(s.venues.hl.length).toBe(1);
    expect(flags.changes()).toEqual([stop, start]);
    expect(logged).toEqual([
      { flag: "RELAY_ENABLED", value: false, operator: "ops-oncall", at: new Date(NOW).toISOString() },
      { flag: "RELAY_ENABLED", value: true, operator: "ops-oncall", at: new Date(NOW).toISOString() },
    ]);
    // a venue flag stops that venue only
    flags.set("HL_ENABLED", false, "ops-oncall");
    h = await s.hl();
    expect((await codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, ip, s.deps))).message).toBe(RELAY_PAUSED);
    const a = s.aster();
    expect((await codeOf(handleSubmit({ buildId: a.b.buildId, signedEnvelope: a.env }, ip, s.deps))).code).toBeNull();
    // flags from the environment: "0" is off, unset is on; unknown flags and odd operator names are refused
    const env = relayFlags({ RELAY_ENABLED: "0", LIGHTER_RH_ENABLED: "0" });
    expect(env.relayEnabled()).toBe(false);
    expect(env.venueEnabled("LIGHTER_RH_ENABLED")).toBe(false);
    expect(env.venueEnabled("HL_ENABLED")).toBe(true);
    expect(() => env.set("NOPE" as never, true, "x")).toThrow("unknown relay flag");
    expect(() => env.set("HL_ENABLED", true, "two words")).toThrow("operator");
  });
});
