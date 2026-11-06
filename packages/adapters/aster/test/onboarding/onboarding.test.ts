// Onboarding rules R6, R9, R10 (todo 14) plus the submit checks.
import { CapstanError, type Hex } from "@capstan/schema";
import { accountSigner, digestTypedData, mgmtSentQuery, parseQuery } from "@capstan/signer-aster";
import { createMemoryGovernor, fakeVenueServer, venueHttp } from "@capstan/venue-client";
import { describe, expect, test } from "bun:test";
import { ASTER_AGENT_TTL_MS, assertMaxFeeRate, buildOnboarding, buildRenewal, ipWhitelistFor, onboardingTemplateHash, submitOnboarding, type AsterVenueTx } from "../../src/onboarding";
import { AGENT, BUILDER, ctx, NOW, OWNER, RELAY_IP, req, testAccount } from "./fixtures";

const param = (tx: AsterVenueTx, k: string) => tx.params.find(([n]) => n === k)?.[1];
const tx = (b: ReturnType<typeof buildOnboarding>, kind: string) => b.steps.find((s) => s.kind === kind)!.venueTx as AsterVenueTx;
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as CapstanError).code;
  }
  return null;
};

describe("aster onboarding", () => {
  test("max-fee-rate", () => {
    const b = buildOnboarding(req(), ctx());
    const bt = tx(b, "aster_approve_builder");
    expect(param(bt, "maxFeeRate")).toBe("0.0003");
    expect(typeof param(bt, "maxFeeRate")).toBe("string");
    expect(b.steps.find((s) => s.kind === "aster_approve_builder")!.typedData!.message.MaxFeeRate).toBe("0.0003");
    expect(assertMaxFeeRate("0.0002")).toBe("0.0002");
    expect(assertMaxFeeRate("0.00030")).toBe("0.00030");
    for (const bad of ["0.00031", "0.0005", "0.001", "0.0011", "0.01", "1"]) expect(code(() => assertMaxFeeRate(bad))).toBe("INVALID_INPUT");
    for (const bad of ["3e-4", "0", "-0.0001", ""]) expect(code(() => assertMaxFeeRate(bad))).toBe("INVALID_INPUT");
    expect(code(() => buildOnboarding(req({ maxFeeRate: "0.002" }), ctx()))).toBe("INVALID_INPUT"); // above the venue cap
    expect(code(() => buildOnboarding(req({ maxFeeRate: "0.0004" }), ctx()))).toBe("INVALID_INPUT"); // above our ceiling
    expect(param(tx(buildOnboarding(req({ maxFeeRate: "0.0002" }), ctx()), "aster_approve_builder"), "maxFeeRate")).toBe("0.0002");
    expect(b.humanReadable[2]).toContain("0.0003 (3 bps)");
  });

  test("single-ip", () => {
    // relay mode: the relay's egress IP, and the line the user reads shows it
    const relay = buildOnboarding(req(), ctx());
    expect(param(tx(relay, "aster_approve_agent"), "ipWhitelist")).toBe(RELAY_IP);
    expect(relay.humanReadable[1]).toContain(RELAY_IP);
    // direct mode: the user's IP, or empty
    expect(param(tx(buildOnboarding(req({ mode: "direct", directIp: "198.51.100.4" }), ctx()), "aster_approve_agent"), "ipWhitelist")).toBe("198.51.100.4");
    expect(param(tx(buildOnboarding(req({ mode: "direct" }), ctx()), "aster_approve_agent"), "ipWhitelist")).toBe("");
    expect(ipWhitelistFor("direct", RELAY_IP, "2001:db8::1")).toBe("2001:db8::1");
    // lists, ranges and junk are refused (the venue's delimiter is unknown)
    for (const bad of ["1.2.3.4,5.6.7.8", "1.2.3.4 5.6.7.8", "1.2.3.0/24", "1.2.3.4;5.6.7.8", "host.example", "999.1.1.1"]) {
      expect(code(() => ipWhitelistFor("direct", RELAY_IP, bad))).toBe("INVALID_INPUT");
      expect(code(() => buildOnboarding(req({ mode: "direct", directIp: bad }), ctx()))).toBe("INVALID_INPUT");
    }
    expect(code(() => buildOnboarding(req(), ctx({ relayEgressIp: "1.2.3.4,5.6.7.8" })))).toBe("INVALID_INPUT");
    expect(code(() => buildOnboarding(req(), ctx({ relayEgressIp: "" })))).toBe("INVALID_INPUT");
    // relay mode ignores a user-supplied IP
    expect(param(tx(buildOnboarding(req({ directIp: "198.51.100.4" }), ctx()), "aster_approve_agent"), "ipWhitelist")).toBe(RELAY_IP);
  });

  test("expiry-30d", () => {
    const b = buildOnboarding(req(), ctx());
    const at = tx(b, "aster_approve_agent");
    expect(param(at, "expired")).toBe(NOW + 30 * 86_400_000);
    expect(ASTER_AGENT_TTL_MS).toBe(2_592_000_000);
    expect(typeof param(at, "expired")).toBe("number"); // uint256 in the typed data, an integer in the query
    expect(b.steps.find((s) => s.kind === "aster_approve_agent")!.typedData!.types.ApproveAgent!.find((f) => f.name === "Expired")!.type).toBe("uint256");
    // renewal: UpdateAgent, new expiry, same fixed permissions
    const later = NOW + 20 * 86_400_000;
    const r = buildRenewal({ owner: OWNER, agentAddress: AGENT, mode: "relay", network: "Mainnet", nowMs: later }, { relayEgressIp: RELAY_IP, builder: BUILDER, nonce: ctx().nonce });
    const ut = r.steps[0]!.venueTx as AsterVenueTx;
    expect(ut.primaryType).toBe("UpdateAgent");
    expect(r.steps[0]!.typedData!.primaryType).toBe("UpdateAgent");
    expect(param(ut, "expired")).toBe(later + ASTER_AGENT_TTL_MS);
    expect(param(ut, "canWithdraw")).toBe(false);
    expect(param(ut, "canSpotTrade")).toBe(false);
    expect(param(ut, "canPerpTrade")).toBe(true);
    // nonces: two distinct, increasing values in one bundle; bundle lives under the 60 s nonce window
    const n1 = param(tx(b, "aster_approve_agent"), "nonce") as number;
    const n2 = param(tx(b, "aster_approve_builder"), "nonce") as number;
    expect(n1).toBe(NOW * 1000);
    expect(n2).toBe(n1 + 1);
    expect(b.expiresAt - NOW).toBeLessThan(60_000);
    expect(b.steps.map((s) => s.kind)).toEqual(["eligibility_declaration", "aster_approve_agent", "aster_approve_builder"]);
    expect(b.templateHash).toBe(onboardingTemplateHash(BUILDER, "Mainnet"));
    expect(onboardingTemplateHash(BUILDER, "Mainnet")).not.toBe(onboardingTemplateHash(BUILDER, "Testnet"));
    // the template hash does not depend on the user
    expect(buildOnboarding(req({ owner: "0x1111111111111111111111111111111111111111" }), ctx()).templateHash).toBe(b.templateHash);
  });

  test("submit-checks-signatures", async () => {
    const main = testAccount("main");
    const other = testAccount("builder");
    const seen: { method: string; path: string; query: string; body: string; type: string | null }[] = [];
    const server = fakeVenueServer({
      "/fapi/v3/approveAgent": async (r) => {
        const u = new URL(r.url);
        seen.push({ method: r.method, path: u.pathname, query: u.search.slice(1), body: await r.text(), type: r.headers.get("content-type") });
        return Response.json({ code: 200, msg: "success" });
      },
      "/fapi/v3/approveBuilder": async (r) => {
        const u = new URL(r.url);
        seen.push({ method: r.method, path: u.pathname, query: u.search.slice(1), body: await r.text(), type: r.headers.get("content-type") });
        return Response.json({ code: 200, msg: "success" });
      },
    });
    try {
      const http = venueHttp("aster", server.url, createMemoryGovernor("t"));
      const b = buildOnboarding(req({ owner: main.address }), ctx());
      const sign = accountSigner(main);
      const sigs = await Promise.all(b.steps.map(async (s, i) => ({ step: i, sig: s.typedData ? await sign(digestTypedData(s.typedData)) : ("0x" as Hex) })));
      const venueSigs = sigs.filter((s) => b.steps[s.step]!.venueTx);
      // a signature from any other key is refused before anything is sent
      const forged = await accountSigner(other)(digestTypedData(b.steps[1]!.typedData!));
      const bad = await submitOnboarding({ bundleId: b.bundleId, signatures: [{ step: 1, sig: forged }, venueSigs[1]!] }, http, b, NOW).catch((e: CapstanError) => e.code);
      expect(bad).toBe("UNAUTHORIZED");
      expect(seen.length).toBe(0);
      // a changed typed message is refused
      const tampered = structuredClone(b);
      (tampered.steps[2]!.typedData!.message as Record<string, unknown>).MaxFeeRate = "0.001";
      expect(await submitOnboarding({ bundleId: b.bundleId, signatures: venueSigs }, http, tampered, NOW).catch((e: CapstanError) => e.code)).toBe("PAYLOAD_MISMATCH");
      expect(await submitOnboarding({ bundleId: b.bundleId, signatures: venueSigs }, http, b, b.expiresAt + 1).catch((e: CapstanError) => e.code)).toBe("BUILD_EXPIRED");
      expect(seen.length).toBe(0);
      const res = await submitOnboarding({ bundleId: b.bundleId, signatures: venueSigs }, http, b, NOW);
      expect(seen.map((s) => [s.method, s.path])).toEqual([["POST", "/fapi/v3/approveAgent"], ["POST", "/fapi/v3/approveBuilder"]]);
      const agentTx = b.steps[1]!.venueTx as AsterVenueTx;
      expect(seen[0]!.query).toBe(mgmtSentQuery(agentTx.params, venueSigs[0]!.sig));
      expect(parseQuery(seen[0]!.query)).toContainEqual(["canWithdraw", "false"]);
      expect(parseQuery(seen[0]!.query).at(-1)).toEqual(["signatureChainId", "56"]);
      expect(seen[0]!.body).toBe("");
      expect(seen[0]!.type).toBe("application/x-www-form-urlencoded");
      expect(res.delegation).toMatchObject({ agentActive: true, builderMaxBps: 3, routing: "ok" });
      expect(res.agentRef).toBe(`aster:${main.address.toLowerCase()}:${AGENT.toLowerCase()}`);
    } finally {
      server.stop();
    }
  });

  test("declined-builder-is-fee-free-unavailable", async () => {
    const main = testAccount("main");
    const server = fakeVenueServer({
      "/fapi/v3/approveAgent": () => Response.json({ code: 200, msg: "success" }),
      "/fapi/v3/approveBuilder": () => Response.json({ code: -1000, msg: "rejected" }, { status: 400 }),
    });
    try {
      const http = venueHttp("aster", server.url, createMemoryGovernor("t"));
      const b = buildOnboarding(req({ owner: main.address }), ctx());
      const sign = accountSigner(main);
      const sigs = [{ step: 1, sig: await sign(digestTypedData(b.steps[1]!.typedData!)) }, { step: 2, sig: await sign(digestTypedData(b.steps[2]!.typedData!)) }];
      const res = await submitOnboarding({ bundleId: b.bundleId, signatures: sigs }, http, b, NOW);
      expect(res.delegation).toMatchObject({ agentActive: true, builderMaxBps: null, routing: "fee_free_unavailable" });
      expect(res.steps.map((s) => s.status)).toEqual(["accepted", "rejected"]);
    } finally {
      server.stop();
    }
  });
});
