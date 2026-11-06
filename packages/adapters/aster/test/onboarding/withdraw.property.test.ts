// R5 (todo 14), spec C2: no built payload, typed message or query string ever asks for withdraw or spot.
import { mgmtSentQuery, parseQuery } from "@capstan/signer-aster";
import { describe, expect, test } from "bun:test";
import { buildOnboarding, buildRenewal, type AsterOnboardingRequest, type AsterVenueTx } from "../../src/onboarding";
import { buildRevocation } from "../../src/revocation";
import { BUILDER, ctx, NOW } from "./fixtures";
import { AsterNonce } from "@capstan/signer-aster";

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const addr = () => `0x${hex(20)}` as const;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const ip = () => (Math.random() < 0.5 ? `${1 + Math.floor(Math.random() * 223)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}` : `2001:db8::${hex(2)}`);

function assertNoWithdrawOrSpot(steps: { typedData?: { message: Record<string, unknown> }; venueTx?: unknown }[], sentQueries: string[], json: string): void {
  for (const s of steps) {
    const m = s.typedData?.message ?? {};
    if ("CanWithdraw" in m) expect(m.CanWithdraw).toBe(false);
    if ("CanSpotTrade" in m) expect(m.CanSpotTrade).toBe(false);
    const tx = s.venueTx as AsterVenueTx | undefined;
    for (const [k, v] of tx?.params ?? []) {
      if (/^canWithdraw$/i.test(k) || /^canSpotTrade$/i.test(k)) expect(v).toBe(false);
    }
  }
  for (const q of sentQueries) {
    for (const [k, v] of parseQuery(q)) if (/^can(Withdraw|SpotTrade)$/i.test(k)) expect(v).toBe("false");
    expect(/canWithdraw=true|canSpotTrade=true/i.test(q)).toBe(false);
  }
  expect(/"Can(Withdraw|SpotTrade)":true|"can(Withdraw|SpotTrade)",true/i.test(json)).toBe(false);
}

describe("aster withdraw property", () => {
  test("never-withdraw", () => {
    const sig = `0x${"ab".repeat(65)}` as const;
    let agentSteps = 0;
    for (let i = 0; i < 1000; i++) {
      const mode = pick(["relay", "direct"] as const);
      const r: AsterOnboardingRequest = {
        owner: addr(),
        agentAddress: addr(),
        mode,
        network: pick(["Mainnet", "Testnet"] as const),
        nowMs: NOW + Math.floor(Math.random() * 1e10),
        ...(mode === "direct" && Math.random() < 0.7 ? { directIp: ip() } : {}),
        ...(Math.random() < 0.5 ? { maxFeeRate: pick(["0.0001", "0.0002", "0.0003", "0.00025"]) } : {}),
      };
      const b = Math.random() < 0.8 ? buildOnboarding(r, ctx({ relayEgressIp: ip() })) : buildRenewal({ owner: r.owner, agentAddress: r.agentAddress, mode: r.mode, network: r.network, nowMs: r.nowMs, ...(r.directIp ? { directIp: r.directIp } : {}) }, { relayEgressIp: ip(), builder: BUILDER, nonce: new AsterNonce() });
      const queries = b.steps.flatMap((s) => (s.venueTx ? [mgmtSentQuery((s.venueTx as AsterVenueTx).params, sig)] : []));
      assertNoWithdrawOrSpot(b.steps as never, queries, JSON.stringify(b));
      for (const s of b.steps) if (s.typedData && "CanWithdraw" in s.typedData.message) agentSteps++;
      // the agent step always asks for perps and nothing else
      const at = b.steps.find((s) => s.typedData?.primaryType === "ApproveAgent" || s.typedData?.primaryType === "UpdateAgent")!;
      expect(at.typedData!.message.CanPerpTrade).toBe(true);
      // and an attempt to slip the flag in is refused, not read
      if (i % 50 === 0) expect(() => buildOnboarding({ ...r, canWithdraw: true } as never, ctx())).toThrow();
      if (i % 50 === 0) expect(() => buildOnboarding({ ...r, canSpotTrade: true } as never, ctx())).toThrow();
    }
    expect(agentSteps).toBe(1000);
    // revocation bundles carry no permission flags at all
    const rv = buildRevocation(addr(), addr(), { builder: BUILDER, nonce: new AsterNonce(), network: "Mainnet", nowMs: NOW });
    assertNoWithdrawOrSpot(rv.steps as never, [], JSON.stringify(rv));
  });
});
