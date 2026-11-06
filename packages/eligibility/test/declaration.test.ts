// R4: the declaration signature must recover to the owner; it lasts 90 days; an expired one refuses writes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CapstanError, type Hex } from "@capstan/schema";
import { decide, DECLARATION_DOMAIN, DECLARATION_STATEMENT, DECLARATION_TTL_S, declarationStep, declarationTypedData, recoverDeclarationSigner, storeDeclaration, UNION_LIST_V1, SANCTIONED_REGIONS } from "../src";
import { dbFixture, geo, IP, NOW, PG, signDeclaration, wallet, type DbFixture } from "./helpers";

const DAY = 86_400_000;

describe("declaration typed data", () => {
  test("shape: CapstanEligibility v1, chain 4663, no verifying contract, 90 days", () => {
    const w = wallet("shape");
    const step = declarationStep(w.address, ["lighter-rh", "hyperliquid"], NOW);
    expect(step.kind).toBe("eligibility_declaration");
    expect(step.signer).toBe("main_wallet");
    const td = step.typedData!;
    expect(td.domain).toEqual({ name: "CapstanEligibility", version: "1", chainId: 4663 });
    expect(td.domain.verifyingContract).toBeUndefined();
    expect(td.primaryType).toBe("Declaration");
    expect(td.types.Declaration!.map((f) => `${f.type} ${f.name}`).join(",")).toBe("address owner,string statement,string[] refusedCountries,string[] venues,uint64 issuedAt,uint64 expiresAt");
    const m = td.message as Record<string, unknown>;
    expect(m.statement).toBe(DECLARATION_STATEMENT);
    expect(m.statement).toBe("I am not a resident or person of the listed countries and regions.");
    expect(m.owner).toBe(w.address.toLowerCase());
    expect(m.venues).toEqual(["hyperliquid", "lighter-rh"]);
    expect(m.expiresAt).toBe((m.issuedAt as number) + DECLARATION_TTL_S);
    expect(DECLARATION_TTL_S).toBe(90 * 86_400);
    for (const c of [...UNION_LIST_V1, ...SANCTIONED_REGIONS, "AE"]) expect(m.refusedCountries as string[]).toContain(c);
    // HL alone does not list AE (its AE rule is equity-only)
    expect((declarationStep(w.address, ["hyperliquid"], NOW).typedData!.message.refusedCountries as string[]).includes("AE")).toBe(false);
    expect(DECLARATION_DOMAIN.chainId).toBe(4663);
  });
});

describe.skipIf(!PG)("declaration storage", () => {
  let f: DbFixture;
  const owner = wallet("decl-owner");
  const mallory = wallet("decl-mallory");
  beforeAll(async () => {
    f = await dbFixture("declaration");
  });
  afterAll(() => f?.drop());

  test("recover-and-expiry", async () => {
    const issued = Math.floor(NOW / 1000);
    const good = await signDeclaration(owner, ["hyperliquid"], issued);
    expect(await recoverDeclarationSigner(good.td, good.sig)).toBe(owner.address.toLowerCase() as Hex);

    // signed by someone else for the owner's address: refused
    const forged = await signDeclaration(mallory, ["hyperliquid"], issued);
    const forgedTd = declarationTypedData(owner.address, ["hyperliquid"], forged.td.message.refusedCountries as string[], issued);
    await expect(storeDeclaration(forgedTd, forged.sig, f.db, NOW)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // a tampered message (one country dropped) no longer recovers to the owner
    const tampered = declarationTypedData(owner.address, ["hyperliquid"], (good.td.message.refusedCountries as string[]).filter((c) => c !== "US"), issued);
    expect(await recoverDeclarationSigner(tampered, good.sig)).not.toBe(owner.address.toLowerCase() as Hex);
    await expect(storeDeclaration(tampered, good.sig, f.db, NOW)).rejects.toBeInstanceOf(CapstanError);
    // garbage signature
    await expect(storeDeclaration(good.td, "0x1234" as Hex, f.db, NOW)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // a wrong domain is not a declaration
    await expect(storeDeclaration({ ...good.td, domain: { ...good.td.domain, chainId: 1 } }, good.sig, f.db, NOW)).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const stored = await storeDeclaration(good.td, good.sig, f.db, NOW);
    expect(stored.id).toMatch(/^dcl_/);
    expect(stored.expiresAt.getTime()).toBe((issued + 90 * 86_400) * 1000);

    const at = (ms: number) => decide({ ip: IP.DE!, owner: owner.address, venue: "hyperliquid", action: "order" }, { geo, db: f.db, now: () => new Date(ms) });
    expect(await at(NOW + 89 * DAY)).toMatchObject({ allowed: true, declarationId: stored.id });
    expect(await at(NOW + 90 * DAY)).toMatchObject({ allowed: false, code: "DECLARATION_MISSING", declarationId: null });
    expect(await at(NOW + 120 * DAY)).toMatchObject({ allowed: false, code: "DECLARATION_MISSING" });
    // reads never need a declaration
    expect(await decide({ ip: IP.DE!, owner: owner.address, venue: "hyperliquid", action: "quote" }, { geo, db: f.db, now: () => new Date(NOW + 120 * DAY) })).toMatchObject({ allowed: true });

    // an expired declaration cannot be stored, and one dated in the future is refused
    const old = await signDeclaration(owner, ["hyperliquid"], issued - 91 * 86_400);
    await expect(storeDeclaration(old.td, old.sig, f.db, NOW)).rejects.toMatchObject({ code: "DECLARATION_MISSING" });
    const future = await signDeclaration(owner, ["hyperliquid"], issued + 3600);
    await expect(storeDeclaration(future.td, future.sig, f.db, NOW)).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // a declaration that omits a refused country does not cover the venue (a stricter list needs a new signature)
    const thin = await signDeclaration(mallory, ["aster"], issued, ["US"]);
    await storeDeclaration(thin.td, thin.sig, f.db, NOW);
    expect(await decide({ ip: IP.DE!, owner: mallory.address, venue: "aster", action: "order" }, { geo, db: f.db, now: () => new Date(NOW) })).toMatchObject({ allowed: false, code: "DECLARATION_MISSING" });
  });
});
