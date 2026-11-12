// The SDK pins equal what the api really builds: a Hyperliquid onboarding bundle from the production composition
// (composeAdapters: eligibility declaration step, policyStepOf, the adapter build), plain and agent-safe, on mainnet
// and testnet, carries a template hash that packages/sdk/src/pins.json lists for that network. Empty pins made every
// production Hyperliquid onboarding TEMPLATE_UNKNOWN (2026-11-12). The venue is a local stand-in; no DB is needed.
import { describe, expect, test } from "bun:test";
import type { AgentPolicy, Hex, VenueId } from "@capstan/schema";
import { fakeVenueServer } from "@capstan/venue-client";
import { hlRoutes, hlState } from "../../../ops/fork/fake-venues";
import { PINS } from "../../../packages/sdk/src/pins";
import { hlTemplateHash } from "../../../packages/sdk/src/onboard";
import { composeAdapters, type BuildAdapter } from "../src/adapters";

const OWNER = "0x00000000000000000000000000000000000a11ce" as Hex;
const AGENT = "0x00000000000000000000000000000000000a9e27" as Hex;
const policy = (): AgentPolicy => ({ owner: OWNER, agents: [{ venue: "hyperliquid", agentRef: `hl:${AGENT}` }], maxNotionalPerOrderUsd: "250", maxGrossNotionalUsd: "1000", maxLeverage: 3, allowedMarkets: ["hyperliquid:-:BTC"], allowedVenues: ["hyperliquid"], maxOrdersPerDay: 50, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), nonce: `n-${Date.now()}` }) as AgentPolicy;

describe("Hyperliquid template pins match the api's real build", () => {
  for (const net of ["mainnet", "testnet"] as const) {
    test(net, async () => {
      const venue = fakeVenueServer(hlRoutes(hlState(net === "mainnet" ? "Mainnet" : "Testnet")) as never);
      try {
        const { adapters } = await composeAdapters({ CAPSTAN_NETWORK: net, CAPSTAN_VENUE_URL_HYPERLIQUID: venue.url, HL_BUILDER_ADDRESS: "0x00000000000000000000000000000000000b1d00" }, { db: null, redis: null });
        const hl = (adapters as Map<VenueId, BuildAdapter>).get("hyperliquid")!;
        const req = { venue: "hyperliquid" as const, owner: OWNER, agentAddress: AGENT, builderMaxBps: 3 };
        const plain = await hl.buildOnboarding(req);
        const safe = await hl.buildOnboarding({ ...req, policy: policy() } as never);
        expect(safe.steps.at(-1)!.kind).toBe("agent_policy");
        const pinned = PINS.networks[net].templateHashes.hyperliquid.map((h) => h.toLowerCase());
        for (const b of [plain, safe]) {
          expect(hlTemplateHash(b).toLowerCase()).toBe(b.templateHash.toLowerCase());
          expect(pinned).toContain(b.templateHash.toLowerCase());
        }
        expect(plain.templateHash).not.toBe(safe.templateHash);
      } finally {
        venue.stop();
      }
    });
  }
});
