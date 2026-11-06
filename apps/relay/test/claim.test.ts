// R10 (todo 30): a direct-mode claim must hash-match the stored build and pass verifySigned; an unknown build or a
// different payload is refused; a second claim for one build returns the first receipt. The 30 s build window does not
// apply to a claim, but every field and signature check still does.
import { afterAll, describe, expect, test } from "bun:test";
import type { SignedEnvelope } from "@capstan/schema";
import { handleClaim } from "../src/pipeline";
import { codeOf, NOW, relayStack } from "./helpers";

const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));

describe("claim", () => {
  test("verify-and-idempotent", async () => {
    const s = relayStack();
    stacks.push(s);
    const resp = { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 777 } }] } } };
    const h = await s.hl();
    const first = await handleClaim({ buildId: h.b.buildId, signedEnvelope: h.env, venueResponse: resp }, s.deps);
    const r = s.receipts.byId(first.receiptId)!;
    expect(r.action).toBe("order.claim");
    expect(r.venueOrderId).toBe("777");
    expect(r.builder).toEqual({ address: h.b.meta.builder!.b, feeBps: 2, rawUnit: "f=20" });
    expect(r.signedPayloadHash).toBe(h.env.payloadHash);
    // the second claim returns the first receipt
    expect((await handleClaim({ buildId: h.b.buildId, signedEnvelope: h.env, venueResponse: resp }, s.deps)).receiptId).toBe(first.receiptId);
    expect(s.receipts.all.filter((x) => x.action === "order.claim").length).toBe(1);
    // unknown build
    expect((await codeOf(handleClaim({ buildId: "01JUNKNOWNBUILD00000000000", signedEnvelope: { ...h.env, buildId: "01JUNKNOWNBUILD00000000000" }, venueResponse: resp }, s.deps))).code).toBe("NOT_FOUND");
    // a payload that is not the build's
    const other = await s.hl({ size: "0.002" });
    const swapped: SignedEnvelope = { ...other.env, buildId: h.b.buildId };
    expect((await codeOf(handleClaim({ buildId: h.b.buildId, signedEnvelope: swapped, venueResponse: resp }, s.deps))).code).toBe("PAYLOAD_MISMATCH");
    const forged = structuredClone(other.env) as SignedEnvelope & { signedBody: { action: { orders: { p: string }[] } } };
    forged.signedBody.action.orders[0]!.p = "1";
    expect((await codeOf(handleClaim({ buildId: other.b.buildId, signedEnvelope: forged, venueResponse: resp }, s.deps))).code).toBe("PAYLOAD_MISMATCH");
    // after the build window: a genuine claim still works, a tampered one is still refused
    s.deps.now = () => NOW + 120_000;
    s.store.builds.get(other.b.buildId)!.expiresAt = NOW - 1;
    expect((await codeOf(handleClaim({ buildId: other.b.buildId, signedEnvelope: forged, venueResponse: resp }, s.deps))).code).toBe("PAYLOAD_MISMATCH");
    const late = await handleClaim({ buildId: other.b.buildId, signedEnvelope: other.env, venueResponse: resp }, s.deps);
    expect(s.receipts.byId(late.receiptId)!.action).toBe("order.claim");
    // a claim marks the payload as used: the relay will not send it too
    expect(s.venues.total()).toBe(0);
  });
});
