// R9, R18 (todo 30): a builder refusal from the venue is BUILDER_APPROVAL_REQUIRED with an onboarding hint and the
// relay never resubmits without the builder field; a venue region reply an adapter recognises becomes GEO_REFUSED with
// a refusal receipt and is cached for that owner and venue for 24 h. No shipped adapter matches any text yet.
import { afterAll, describe, expect, test } from "bun:test";
import { BUILDER_HINT, handleSubmit } from "../src/pipeline";
import type { RelayVenue } from "../src/types";
import { codeOf, NOW, relayStack, USER_A } from "./helpers";

const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));

describe("venue submit", () => {
  test("no-strip", async () => {
    const s = relayStack();
    stacks.push(s);
    s.venues.hlReply.value = () => ({ status: "err", response: "Builder fee has not been approved." });
    const h = await s.hl();
    const r = await codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: "203.0.113.60" }, s.deps));
    expect(r.code).toBe("BUILDER_APPROVAL_REQUIRED");
    expect(r.message).toContain(BUILDER_HINT);
    expect(r.receiptId).toBeDefined();
    expect(s.receipts.byId(r.receiptId!)!.action).toBe("order.submit"); // the failed submit is still receipted
    // exactly one request, and it carried the builder field: nothing was resent without it
    expect(s.venues.hl.length).toBe(1);
    expect((JSON.parse(s.venues.hl[0]!.body) as { action: { builder?: { b: string; f: number } } }).action.builder?.f).toBe(20);
    // the same payload is never sent again
    expect((await codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: "203.0.113.60" }, s.deps))).code).toBe("DUPLICATE_PAYLOAD");
    expect(s.venues.hl.length).toBe(1);
  });

  test("venue-geo-signal", async () => {
    const s = relayStack();
    stacks.push(s);
    // shipped venues match nothing until 41 records a real venue text on testnet
    for (const v of s.deps.venues.values()) expect(v.isGeoError).toBeUndefined();
    const hl = s.deps.venues.get("hyperliquid")!;
    const withSignal: RelayVenue = { ...hl, isGeoError: (r) => /recorded-region-refusal-text/.test(JSON.stringify(r.venueResponse ?? "")) };
    s.deps.venues.set("hyperliquid", withSignal);
    s.venues.hlReply.value = () => ({ status: "err", response: "recorded-region-refusal-text" });
    let now = NOW;
    s.deps.now = () => now;
    const h = await s.hl();
    const r = await codeOf(handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, { ip: "203.0.113.61" }, s.deps));
    expect(r.code).toBe("GEO_REFUSED");
    expect(s.receipts.byId(r.receiptId!)!.action).toBe("refusal");
    expect(await s.deps.venueSignals.get(USER_A, "hyperliquid", now)).toBe(true);
    // cached: the next order for that owner and venue is refused before any venue request
    const sent = s.venues.hl.length;
    const h2 = await s.hl();
    expect((await codeOf(handleSubmit({ buildId: h2.b.buildId, signedEnvelope: h2.env }, { ip: "203.0.113.61" }, s.deps))).code).toBe("GEO_REFUSED");
    expect(s.venues.hl.length).toBe(sent);
    // another venue for the same owner is not affected
    expect(await s.deps.venueSignals.get(USER_A, "aster", now)).toBe(false);
    // after 24 h the cache entry lapses
    now += 86_400_001;
    expect(await s.deps.venueSignals.get(USER_A, "hyperliquid", now)).toBe(false);
  });
});
