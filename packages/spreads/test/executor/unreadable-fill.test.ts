// R1-8-01: a leg whose fill cannot be read is refused before any order is sent, and the SDK's fill reader never turns
// an unread or unfinished order into a confirmed no-fill.
import { describe, expect, test } from "bun:test";
import { venueFillReader } from "../../../sdk/src/spreads";
import { execute } from "../../src/executor";
import { LOTS, planOf, sim } from "./sim";

const OWNER = "0x00000000000000000000000000000000000000a1" as const;

describe("unreadable fills (R1-8-01)", () => {
  test("a leg on a venue with no fill reader: nothing is sent and the plan fails with the reason", async () => {
    const p = planOf({ hedgeFailurePolicy: "retry_then_flatten" });
    const s = sim(() => ({}), LOTS(p));
    const r = await execute(p, { ...s.ports, canReadFill: (v) => v === "hyperliquid" });
    expect(r.status).toBe("failed");
    expect(s.subs.length).toBe(0);
    expect(s.events).toEqual([{ kind: "failed", data: { reason: `fills on ${p.legA.venue} cannot be read here, so nothing was sent` } }]);
  });

  test("the reader: only a final Hyperliquid status is done", async () => {
    const answers: unknown[] = [];
    const f = (async () => Response.json(answers.shift())) as unknown as typeof fetch;
    const r = venueFillReader({ owner: OWNER, fetch: f, hyperliquidHost: "http://hl.test" });
    expect(r.canReadFill!("hyperliquid")).toBe(true);
    expect(r.canReadFill!("aster")).toBe(false);
    expect(r.canReadFill!("lighter-mainnet")).toBe(false);
    const read = (a: unknown, venue = "hyperliquid", oid = "77") => (answers.push(a), r.fillOf(venue as never, oid));
    const unknown = { filled: "0", avgPx: null, done: false };
    expect(await r.fillOf("aster", "123")).toEqual(unknown);
    expect(await read({ status: "unknownOid" })).toEqual(unknown);
    expect(await read({ status: "order", order: { status: "filled" } })).toEqual(unknown);
    expect(await read({ status: "order", order: { order: { origSz: "1", sz: "x" }, status: "filled" } })).toEqual(unknown);
    expect(await read({ status: "order", order: { order: { origSz: "1", sz: "2" }, status: "filled" } })).toEqual(unknown);
    expect(await read({ status: "order", order: { order: { origSz: "1", sz: "0" } } })).toEqual(unknown);
    expect(await read({ status: "order", order: { order: { origSz: "1", sz: "0.4" }, status: "open" } })).toEqual({ filled: "0.6", avgPx: null, done: false });
    // statuses that are not final are never done (an order that can still fill), whatever else the answer says
    expect(await read({ status: "order", order: { order: { origSz: "1", sz: "0.4" }, status: "triggered" } })).toEqual({ filled: "0.6", avgPx: null, done: false });
    expect(await read({ status: "order", order: { order: { origSz: "1", sz: "1" }, status: "triggered" } })).toEqual({ filled: "0", avgPx: null, done: false });
    expect(await read({ status: "order", order: { order: { origSz: "1", sz: "1" }, status: "someNewStatus" } })).toEqual({ filled: "0", avgPx: null, done: false });
    expect(await read({ status: "order", order: { order: { origSz: "1", sz: "1" }, status: "Open" } })).toEqual({ filled: "0", avgPx: null, done: false });
    expect(await read({ status: "order", order: { order: { origSz: "1", sz: "1" }, status: "scheduledCancel" } })).toEqual({ filled: "0", avgPx: null, done: true });
    expect(await read({ status: "order", order: { order: { origSz: "1", sz: "0" }, status: "filled" } })).toEqual({ filled: "1", avgPx: null, done: true });
    expect(await read({ status: "order", order: { order: { origSz: "1", sz: "1" }, status: "canceled" } })).toEqual({ filled: "0", avgPx: null, done: true });
    expect(await read({ status: "order", order: { order: { origSz: "1", sz: "1" }, status: "iocCancelRejected" } })).toEqual({ filled: "0", avgPx: null, done: true });
    expect(await read({ status: "order", order: { order: { origSz: "1", sz: "0" }, status: "filled" } }, "hyperliquid", "not-a-number")).toEqual(unknown);
  });
});
