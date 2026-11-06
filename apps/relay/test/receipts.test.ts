// R11, R14 (todo 30): every successful submit and claim has exactly one receipt with builder fields from the adapter
// draft; a failed venue submit still gets an order.submit receipt with the venue error hash; a cancel build gets
// order.cancel and a close-all payload (a reduce-only order) gets order.submit.
import { afterAll, describe, expect, test } from "bun:test";
import { verifyReceiptSig } from "@capstan/receipts";
import { handleClaim, handleSubmit } from "../src/pipeline";
import { sha256Jcs } from "../src/venues";
import { codeOf, relayStack } from "./helpers";

const stacks: ReturnType<typeof relayStack>[] = [];
afterAll(() => stacks.forEach((s) => s.stop()));

describe("receipts", () => {
  test("one-per-action", async () => {
    const s = relayStack();
    stacks.push(s);
    const ip = { ip: "203.0.113.70" };
    const h = await s.hl();
    const rh = await handleSubmit({ buildId: h.b.buildId, signedEnvelope: h.env }, ip, s.deps);
    const a = s.aster();
    const ra = await handleSubmit({ buildId: a.b.buildId, signedEnvelope: a.env }, ip, s.deps);
    const l = s.lighter();
    const rl = await handleSubmit({ buildId: l.b.buildId, signedEnvelope: l.env }, ip, s.deps);
    for (const [r, buildId] of [[rh, h.b.buildId], [ra, a.b.buildId], [rl, l.b.buildId]] as const) {
      const mine = s.receipts.all.filter((x) => x.buildId === buildId);
      expect(mine.length).toBe(1);
      expect(mine[0]!.receiptId).toBe(r.receiptId);
      expect(mine[0]!.action).toBe("order.submit");
      expect(verifyReceiptSig(mine[0]!, [s.receipts.signer])).toBe(true);
    }
    expect(s.receipts.byId(rh.receiptId)!.builder).toEqual({ address: h.b.meta.builder!.b, feeBps: 2, rawUnit: "f=20" });
    const asterBuilder = (a.b.payload as { params: [string, unknown][] }).params.find(([k]) => k === "builder")![1];
    expect(s.receipts.byId(ra.receiptId)!.builder).toEqual({ address: asterBuilder as `0x${string}`, feeBps: 2, rawUnit: "feeRate=0.0002" });
    expect(s.receipts.byId(ra.receiptId)!.venueOrderId).toBe("9007199254740993"); // venue ids stay strings
    expect(s.receipts.byId(rl.receiptId)!.builder).toBeNull(); // Lighter charges no builder fee
    expect(s.receipts.byId(rl.receiptId)!.txHash).toBe(`0x${"ab".repeat(32)}`);

    // a failed venue submit: an order.submit receipt carrying the hash of the venue's answer
    const failure = { status: "err", response: "Insufficient margin to place order." };
    s.venues.hlReply.value = () => failure;
    const f = await s.hl();
    const rf = await codeOf(handleSubmit({ buildId: f.b.buildId, signedEnvelope: f.env }, ip, s.deps));
    expect(rf.code).toBe("VENUE_ERROR");
    const fr = s.receipts.byId(rf.receiptId!)!;
    expect(fr.action).toBe("order.submit");
    expect(fr.venueResponseHash).toBe(sha256Jcs(failure));
    expect(s.receipts.all.filter((x) => x.buildId === f.b.buildId).length).toBe(1);

    // a claim: exactly one order.claim receipt
    const c = await s.hl();
    await handleClaim({ buildId: c.b.buildId, signedEnvelope: c.env, venueResponse: { status: "ok" } }, s.deps);
    await handleClaim({ buildId: c.b.buildId, signedEnvelope: c.env, venueResponse: { status: "ok" } }, s.deps);
    expect(s.receipts.all.filter((x) => x.buildId === c.b.buildId).map((x) => x.action)).toEqual(["order.claim"]);
  });

  test("cancel-action", async () => {
    const s = relayStack();
    stacks.push(s);
    s.venues.hlReply.value = () => ({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } });
    const c = await s.hl({}, { kind: "cancel" });
    const r = await handleSubmit({ buildId: c.b.buildId, signedEnvelope: c.env }, { ip: "203.0.113.71" }, s.deps);
    expect(s.receipts.byId(r.receiptId)!.action).toBe("order.cancel");
    expect(r.order.status).toBe("cancelled");
    // a close-all payload is a reduce-only order: order.submit
    s.venues.hlReply.value = () => ({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 1 } }] } } });
    const close = await s.hl({ reduceOnly: true, side: "sell" }, {});
    s.store.builds.get(close.b.buildId)!.kind = "close";
    const rc = await handleSubmit({ buildId: close.b.buildId, signedEnvelope: close.env }, { ip: "203.0.113.71" }, s.deps);
    expect(s.receipts.byId(rc.receiptId)!.action).toBe("order.submit");
  });
});
