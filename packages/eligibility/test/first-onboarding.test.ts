// Found on the fork run (todo 40): the declaration is step 0 of the onboarding bundle, so an owner's first onboarding
// must pass the edge without a stored declaration (the submit stores the signed one before any venue step). Orders,
// spread legs and agent-initiated onboarding still need a stored declaration; geography is still checked first.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decide } from "../src";
import { dbFixture, geo, IP, NOW, PG, signDeclaration, wallet, type DbFixture } from "./helpers";

describe.skipIf(!PG)("first onboarding", () => {
  let f: DbFixture;
  const owner = wallet("first-onboarding-owner");
  const now = () => new Date(NOW);
  beforeAll(async () => {
    f = await dbFixture("first_onboarding");
  });
  afterAll(async () => {
    await f?.drop();
  });

  test("owner-onboarding-without-declaration", async () => {
    const d = (input: Parameters<typeof decide>[0]) => decide(input, { geo, db: f.db, now });
    // the owner's own first onboarding: allowed, nothing stored yet
    expect(await d({ ip: IP.DE!, owner: owner.address, venue: "hyperliquid", action: "onboarding" })).toMatchObject({ allowed: true, declarationId: null });
    // a refused region is still refused, and an order still needs the declaration
    expect(await d({ ip: IP.US!, owner: owner.address, venue: "hyperliquid", action: "onboarding" })).toMatchObject({ allowed: false, code: "GEO_REFUSED" });
    expect(await d({ ip: IP.DE!, owner: owner.address, venue: "hyperliquid", action: "order" })).toMatchObject({ allowed: false, code: "DECLARATION_MISSING" });
    // no owner, or an agent asking: default-deny as before
    expect(await d({ ip: IP.DE!, venue: "hyperliquid", action: "onboarding" })).toMatchObject({ allowed: false, code: "DECLARATION_MISSING" });
    expect(await d({ ip: IP.DE!, owner: owner.address, venue: "hyperliquid", action: "onboarding", agentRef: "hl:0xunknown" })).toMatchObject({ allowed: false, code: "DECLARATION_MISSING" });
    // once the signed declaration is stored, the order passes and names it
    const { storeDeclaration } = await import("../src");
    const s = await signDeclaration(owner, ["hyperliquid"], Math.floor(NOW / 1000));
    const stored = await storeDeclaration(s.td, s.sig, f.db, NOW);
    expect(await d({ ip: IP.DE!, owner: owner.address, venue: "hyperliquid", action: "order" })).toMatchObject({ allowed: true, declarationId: stored.id });
  });
});
