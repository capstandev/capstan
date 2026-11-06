// Shared setup for the order tests: a fake Aster (recorded fixtures), an adapter with execution on, the public test
// accounts (main wallet = owner, signer = agent) and a build context.
import type { BuildContext, OrderIntent, SignedEnvelope, UnsignedVenuePayload } from "@capstan/schema";
import { accountSigner, payloadHashOf, queryString } from "@capstan/signer-aster";
import type { FakeHandler } from "@capstan/venue-client";
import { ASTER_MAINNET } from "../../src/config";
import { createAdapter, type AsterAdapterDeps } from "../../src/adapter";
import type { AsterOrderPayload } from "../../src/orders";
import { defaultRoutes, harness } from "../helpers";
import { testAccount } from "../../../../signers/aster/test/keys";

export const owner = testAccount("main");
export const agent = testAccount("signer");
export const BUILDER = "0xF516fddd46548e304E1bce4DB32FeA7C294E56d2" as const;
export const NOW = 1_793_933_000_000;

export function ctx(over: Partial<BuildContext> = {}): BuildContext {
  return {
    owner: owner.address,
    agentRef: `aster:${owner.address.toLowerCase()}:${agent.address.toLowerCase()}`,
    identity: { venue: "aster", owner: owner.address, agentAddress: agent.address },
    builderFee: { decimalRate: "0.0002" },
    approvedMaxBps: 3,
    nowMs: NOW,
    eligibilityDecisionId: "elig_test",
    policyId: null,
    ...over,
  };
}

export function intent(over: Partial<OrderIntent> = {}): OrderIntent {
  return { marketId: "aster:-:BTCUSDT", side: "buy", size: "0.001", type: "limit", limitPx: "70000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50, ...over };
}

export function setup(routes: Record<string, FakeHandler> = {}, deps: Partial<AsterAdapterDeps> = {}) {
  const h = harness(defaultRoutes(routes), { now: () => NOW });
  const adapter = createAdapter({ ...ASTER_MAINNET, builder: BUILDER, execution: true }, { http: h.http, cache: null, reader: h.reader, now: () => NOW, ...deps });
  return { ...h, adapter };
}

/** What the SDK does: sign the exact query string with the agent key and wrap it in an envelope. */
export async function sign(build: UnsignedVenuePayload, signer = agent, body?: string): Promise<SignedEnvelope & { signedBody: string }> {
  const p = build.payload as AsterOrderPayload;
  const qs = body ?? queryString(p.params);
  const signature = await accountSigner(signer)(build.digest);
  return { buildId: build.buildId, venue: "aster", encoding: "aster_v3_params", signedBody: qs, signature, signerRef: signer.address, payloadHash: payloadHashOf(qs) };
}
