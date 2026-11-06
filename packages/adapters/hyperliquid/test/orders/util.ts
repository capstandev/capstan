// Shared setup for the order tests: a fixture reader, a cache with fresh books, an agent key and a build context.
import { memoryMarketDataCache } from "@capstan/core";
import type { Hex, OrderBook, SignedEnvelope } from "@capstan/schema";
import { addressOf, padRs, postBody, signDigest } from "@capstan/signer-hl";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { createAdapter, createHlReader, NonceSource, payloadHash, type HlAdapterDeps, type HlBuildContext, type HlBuildDeps, type HlUnsignedPayload } from "../../src";
import { BUILDER, CFG, fixtureHttp, USER_A } from "../helpers";

export const key = (l: string) => keccak_256(utf8ToBytes(`capstan-hl-orders-test:${l}`)); // test-key
export const AGENT_KEY = key("agent");
export const AGENT = addressOf(AGENT_KEY).toLowerCase() as Hex;
export const OTHER_KEY = key("other");
/** Fixture book time + 1 s, so recorded and synthetic fixture books are fresh. */
export const T0 = 1793929036000;

export function book(marketId: string, mid: number, asOfMs: number, levels = 10, step = 0.5, sz = "1.0"): OrderBook {
  const bids: [string, string][] = [];
  const asks: [string, string][] = [];
  for (let i = 0; i < levels; i++) {
    bids.push([(mid - step * (i + 1)).toFixed(1), sz]);
    asks.push([(mid + step * (i + 1)).toFixed(1), sz]);
  }
  return { marketId, bids, asks, asOf: new Date(asOfMs).toISOString() };
}

export function setup(override?: (b: Record<string, any>) => unknown, over: Partial<HlAdapterDeps> = {}) {
  const http = fixtureHttp((b) => {
    const o = override?.(b);
    if (o !== undefined) return o;
    if (b.type === "maxBuilderFee") return 30;
    return undefined;
  });
  const cache = memoryMarketDataCache();
  const reader = createHlReader(CFG, http, cache, { now: () => T0 });
  const nonces = new NonceSource();
  const deps: HlBuildDeps = { cfg: CFG, reader, cache, nonces, enabled: () => true };
  const adapter = createAdapter(CFG as typeof CFG & { builderAddress: Hex }, { http, cache, reader, nonces, now: () => T0, enabled: () => true, ...over });
  return { http, cache, reader, deps, adapter };
}

export function ctx(over: Partial<HlBuildContext> = {}): HlBuildContext {
  return {
    owner: USER_A,
    agentRef: `hl:${AGENT}`,
    identity: { venue: "hyperliquid", owner: USER_A, agentAddress: AGENT },
    builderFee: { tenthsBp: 20 },
    approvedMaxBps: 3,
    nowMs: T0,
    eligibilityDecisionId: "elig-test",
    policyId: null,
    feeTier: { takerRate: "0.00045", makerRate: "0.00015", source: "base" },
    ...over,
  };
}

export function sign(build: HlUnsignedPayload, sk: Uint8Array = AGENT_KEY, mutate?: (body: any) => void, resign = true): SignedEnvelope {
  const p = build.payload;
  let sig = signDigest(build.digest, sk);
  const body = postBody(p.action, sig, p.nonce, undefined, p.expiresAfter) as any;
  if (mutate) {
    mutate(body);
    if (resign) {
      // re-sign the mutated body so only the field check can catch it
      const { l1Digest } = require("@capstan/signer-hl") as typeof import("@capstan/signer-hl");
      sig = signDigest(l1Digest(body.action, null, body.nonce, CFG.network, body.expiresAfter ?? undefined), sk);
      body.signature = sig;
    }
  }
  const s = padRs(body.signature);
  return { buildId: build.buildId, venue: "hyperliquid", encoding: "hl_l1_action", signedBody: body, signature: `0x${s.r.slice(2)}${s.s.slice(2)}${s.v.toString(16)}` as Hex, signerRef: AGENT, payloadHash: payloadHash(body) };
}

export { BUILDER, USER_A };
