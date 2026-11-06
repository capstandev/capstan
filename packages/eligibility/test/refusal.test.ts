// R6: every refusal writes an eligibility_decisions row and a signed `refusal` receipt carrying the decision id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@capstan/core";
import { eq } from "drizzle-orm";
import { verifyReceiptSig } from "@capstan/receipts";
import { decide, refusalReceipt, WRITE_ACTIONS, type EligibilityDecision } from "../src";
import { dbFixture, geo, IP, NOW, PG, receiptSigner, wallet, type DbFixture } from "./helpers";

describe.skipIf(!PG)("refusal receipts", () => {
  let f: DbFixture;
  const owner = wallet("refusal-owner");
  beforeAll(async () => {
    f = await dbFixture("refusal");
  });
  afterAll(() => f?.drop());

  test("receipt-per-refusal", async () => {
    const now = () => new Date(NOW);
    const cases: { ip: string; venue: "hyperliquid" | "lighter-rh" | "arcus"; code: string }[] = [
      { ip: IP.US!, venue: "hyperliquid", code: "GEO_REFUSED" },
      { ip: IP.AE!, venue: "lighter-rh", code: "GEO_REFUSED" },
      { ip: IP.DE!, venue: "hyperliquid", code: "DECLARATION_MISSING" },
      { ip: IP.DE!, venue: "arcus", code: "VENUE_DATA_ONLY" },
      { ip: "10.0.0.1", venue: "hyperliquid", code: "GEO_REFUSED" },
    ];
    const ids = new Set<string>();
    const body = { venue: "hyperliquid", marketId: "hyperliquid:-:BTC", side: "buy", size: "0.01" };
    for (const c of cases) {
      for (const action of WRITE_ACTIONS) {
        // an owner's first onboarding signs the declaration inside the bundle, so it is not refused for a missing one
        // (first-onboarding.test.ts); orders and spread legs still are
        if (c.code === "DECLARATION_MISSING" && action === "onboarding") continue;
        // the same body twice: two refusals, two receipts
        for (let i = 0; i < 2; i++) {
          const d: EligibilityDecision = await decide({ ip: c.ip, owner: owner.address, venue: c.venue, action }, { geo, db: f.db, now });
          expect(d.allowed).toBe(false);
          expect(d.code).toBe(c.code as never);
          const rows = await f.db.select().from(schema.eligibilityDecisions).where(eq(schema.eligibilityDecisions.id, d.id));
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ allowed: false, code: c.code, venue: c.venue, owner: owner.address.toLowerCase(), rulesVersion: 1 });
          const r = await refusalReceipt(d, body, (x) => f.receipts.issue(x), { owner: owner.address, venue: c.venue });
          expect(r.action).toBe("refusal");
          expect(r.eligibilityDecisionId).toBe(d.id);
          expect(r.owner).toBe(owner.address.toLowerCase() as never);
          expect(r.venueOrderId).toBeNull();
          expect(r.txHash).toBeNull();
          expect(verifyReceiptSig(r, [receiptSigner("refusal").address])).toBe(true);
          expect(ids.has(r.receiptId)).toBe(false);
          ids.add(r.receiptId);
          const stored = await f.db.select().from(schema.receipts).where(eq(schema.receipts.id, r.receiptId));
          expect((stored[0]!.body as { eligibilityDecisionId: string }).eligibilityDecisionId).toBe(d.id);
        }
      }
    }
    expect(ids.size).toBe((cases.length * WRITE_ACTIONS.length - 1) * 2); // minus the one skipped onboarding case
    // an allowed decision has no refusal receipt
    await expect(refusalReceipt({ id: "eld_x", allowed: true, rulesVersion: 1, ipCountry: "DE", declarationId: "dcl_x" }, body, (x) => f.receipts.issue(x))).rejects.toThrow("not a refusal");
  });
});
