// R3: agent default-deny. An agent request needs an active delegation and a valid declaration of the owner that
// agent is bound to, even from an allowed country.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decide } from "../src";
import { dbFixture, geo, IP, NOW, PG, wallet, type DbFixture } from "./helpers";

const now = () => new Date(NOW);

describe.skipIf(!PG)("agent requests", () => {
  let f: DbFixture;
  const owner = wallet("agent-owner");
  const other = wallet("agent-other");
  beforeAll(async () => {
    f = await dbFixture("agent");
    await f.agent("ag_undeclared", owner.address, "hyperliquid");
    await f.agent("ag_other", other.address, "hyperliquid");
    await f.agent("ag_killed", other.address, "hyperliquid", "killed");
  });
  afterAll(() => f?.drop());
  const run = (agentRef: string, ownerAddr?: `0x${string}`) => decide({ ip: IP.DE!, venue: "hyperliquid", action: "order", agentRef, ...(ownerAddr ? { owner: ownerAddr } : {}) }, { geo, db: f.db, now });

  test("default-deny", async () => {
    // allowed country, active agent, owner has no declaration yet
    expect(await run("ag_undeclared")).toMatchObject({ allowed: false, code: "DECLARATION_MISSING", ipCountry: "DE" });
    expect(await run("ag_undeclared", owner.address)).toMatchObject({ allowed: false, code: "DECLARATION_MISSING" });
    // an unknown agent is refused even when the named owner has a declaration
    await f.declare(other, ["hyperliquid"]);
    expect(await run("ag_unknown", other.address)).toMatchObject({ allowed: false, code: "DECLARATION_MISSING" });
    // a killed agent is refused
    expect(await run("ag_killed", other.address)).toMatchObject({ allowed: false, code: "DECLARATION_MISSING" });
    // an agent bound to `owner` cannot borrow `other`'s declaration
    expect(await run("ag_undeclared", other.address)).toMatchObject({ allowed: false, code: "DECLARATION_MISSING" });
    // bound and declared: allowed, with or without the owner named
    expect(await run("ag_other")).toMatchObject({ allowed: true });
    expect(await run("ag_other", other.address)).toMatchObject({ allowed: true });
    // once the owner declares, its agent passes
    await f.declare(owner, ["hyperliquid"]);
    expect(await run("ag_undeclared")).toMatchObject({ allowed: true });
    // a declaration for another venue does not cover this one
    expect(await decide({ ip: IP.DE!, venue: "aster", action: "order", agentRef: "ag_other" }, { geo, db: f.db, now })).toMatchObject({ allowed: false, code: "DECLARATION_MISSING" });
  });
});
