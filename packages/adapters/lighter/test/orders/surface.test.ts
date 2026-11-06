// R10: the signer wrapper offers no transfer or withdraw builder and neither does this adapter; submit refuses any
// fund-moving tx type before a request; buildRevocation never includes a transfer.
import { afterAll, describe, expect, test } from "bun:test";
import * as signerPkg from "@capstan/signer-lighter-wasm";
import { createMemoryGovernor, fakeVenueServer, venueHttp } from "@capstan/venue-client";
import * as adapterPkg from "../../src";
import { buildRevocation, createLighterAdapter, FORBIDDEN_TX_TYPES, LIGHTER_CONFIGS, SENDABLE_TX_TYPES, submitTx } from "../../src";
import { identity, NOW } from "../build-helpers";
import { json } from "../helpers";

const FORBIDDEN = /transfer|withdraw|subaccount|sub_account|pool|stake|margin|leverage/i;
const srv = fakeVenueServer({ "POST /api/v1/sendTx": () => json({ code: 200, tx_hash: "ab" }) });
afterAll(() => srv.stop());

describe("surface", () => {
  test("no-transfer", async () => {
    expect(Object.keys(signerPkg).filter((k) => FORBIDDEN.test(k))).toEqual([]);
    // no export moves funds: no name mentions transfer or withdraw, and no builder or sender touches sub-accounts,
    // pools, stakes, margin or leverage (read helpers such as marginModesOf are fine)
    const ACTION = /^(build|sign|send|submit|create|approve|update)\w*(subaccount|sub_account|pool|stake|margin|leverage)/i;
    expect(Object.keys(adapterPkg).filter((k) => (/transfer|withdraw/i.test(k) && k !== "FORBIDDEN_TX_TYPES") || ACTION.test(k))).toEqual([]);
    const http = venueHttp("lighter-304", srv.url, createMemoryGovernor("t"));
    const adapter = createLighterAdapter(LIGHTER_CONFIGS.mainnet, { http, cache: null, execution: true });
    expect(adapter.caps.canWithdraw).toBe(false);
    expect(Object.keys(adapter).filter((k) => FORBIDDEN.test(k))).toEqual([]);
    // transfer (12), withdraw (13), sub-account (9), pool, shares, margin, account config: never sent
    for (const t of [9, 10, 11, 12, 13, 17, 18, 19, 20, 28, 29, 41, 42, 43]) await expect(submitTx({ txType: t, txInfo: "{}" }, { http, cfg: LIGHTER_CONFIGS.mainnet })).rejects.toThrow(/never sent/);
    expect(srv.hits).toEqual([]);
    expect(SENDABLE_TX_TYPES).toEqual([8, 14, 15, 16, 45]);
    for (const t of FORBIDDEN_TX_TYPES) expect(SENDABLE_TX_TYPES).not.toContain(t);
    // revocation is a key replacement plus an approval reset, nothing else
    const b = await buildRevocation(identity(LIGHTER_CONFIGS.mainnet, 99, 9), { cfg: LIGHTER_CONFIGS.mainnet, reader: { nextNonce: async () => 3 }, replacementPubKey: "ef".repeat(40), nowMs: NOW, integratorAccountIndex: 18971 });
    expect(b.steps.map((s) => (s.venueTx as { txType: number }).txType)).toEqual([8, 45]);
    expect(b.steps.map((s) => s.kind)).toEqual(["revoke_agent", "revoke_builder"]);
    const reset = b.steps[1]!.venueTx as { args: Record<string, number> };
    expect(reset.args).toMatchObject({ approvalExpiryMs: 0, maxPerpsTakerFee: 0, maxPerpsMakerFee: 0, maxSpotTakerFee: 0, maxSpotMakerFee: 0 });
    expect(JSON.stringify(b).match(/transfer|withdraw/i)).toBeNull();
    expect((b.steps[0]!.venueTx as { args: { apiKeyIndex: number } }).args.apiKeyIndex).toBe(9); // same index
  });
});
