// R1: RH and mainnet are separate identities. A user with both gets two VenueIdentity rows, two key indexes and two
// nonce trackers; nothing carries over.
import { afterAll, describe, expect, test } from "bun:test";
import { createMemoryGovernor, venueHttp } from "@capstan/venue-client";
import { createLighterAdapter, LIGHTER_CONFIGS, preflight } from "../../src";
import { fakeClock, fakeLighter, FIXTURE_OWNER, json } from "../helpers";

const keys = (used: number[]) => () => json({ code: 200, api_keys: used.map((i) => ({ account_index: 1, api_key_index: i, nonce: 5, public_key: "ab".repeat(40), transaction_time: 0 })) });
const main = fakeLighter("lighter-304", {
  "GET /api/v1/accountsByL1Address": () => json({ code: 200, l1_address: FIXTURE_OWNER, sub_accounts: [{ index: 3, account_type: 0 }] }),
  "GET /api/v1/apikeys": keys([0, 1, 2, 3, 4]),
  "GET /api/v1/nextNonce": () => json({ code: 200, nonce: 900 }),
});
const rh = fakeLighter("lighter-466324", {
  "GET /api/v1/accountsByL1Address": () => json({ code: 200, l1_address: FIXTURE_OWNER, sub_accounts: [{ index: 52007, account_type: 0 }] }),
  "GET /api/v1/apikeys": keys([0, 1, 2, 3]),
  "GET /api/v1/nextNonce": () => json({ code: 200, nonce: 12 }),
});
afterAll(() => {
  main.stop();
  rh.stop();
});

describe("rh identity", () => {
  test("separate-exchanges", async () => {
    const gov = createMemoryGovernor("t", fakeClock().opts);
    const a = createLighterAdapter(LIGHTER_CONFIGS.mainnet, { http: venueHttp("lighter-304", main.url, gov), cache: null, execution: true });
    const b = createLighterAdapter(LIGHTER_CONFIGS.rh, { http: venueHttp("lighter-466324", rh.url, gov), cache: null, execution: true });
    const pa = await preflight(a.reader, FIXTURE_OWNER);
    const pb = await preflight(b.reader, FIXTURE_OWNER);
    expect(pa).toEqual({ accountIndex: 3, freeKeyIndex: 5, depositRequired: false });
    expect(pb).toEqual({ accountIndex: 52007, freeKeyIndex: 4, depositRequired: false });
    const idA = { venue: "lighter-mainnet" as const, owner: FIXTURE_OWNER, accountIndex: pa.accountIndex!, apiKeyIndex: pa.freeKeyIndex! };
    const idB = { venue: "lighter-rh" as const, owner: FIXTURE_OWNER, accountIndex: pb.accountIndex!, apiKeyIndex: pb.freeKeyIndex! };
    expect(idA.venue).not.toBe(idB.venue);
    // nonce trackers are per adapter (per exchange) and per key
    await a.nonces.seed(idA.accountIndex, idA.apiKeyIndex);
    await b.nonces.seed(idB.accountIndex, idB.apiKeyIndex);
    expect(a.nonces.next(idA.accountIndex, idA.apiKeyIndex)).toBe(900);
    expect(b.nonces.next(idB.accountIndex, idB.apiKeyIndex)).toBe(12);
    expect(a.nonces.next(idA.accountIndex, idA.apiKeyIndex)).toBe(901);
    expect(b.nonces.seeded(idA.accountIndex, idA.apiKeyIndex)).toBe(false);
    expect(a.nonces).not.toBe(b.nonces);
    // an identity of one exchange is refused by the other
    await expect(b.getAccount(idA)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(a.getAccount(idB)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(b.buildOnboarding({ venue: "lighter-mainnet", owner: FIXTURE_OWNER, lighterPubKey: "ab".repeat(40) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // different signing ids in every build domain
    expect(a.caps.signingDomain?.chainId).toBe(304);
    expect(b.caps.signingDomain?.chainId).toBe(466324);
  });
});
