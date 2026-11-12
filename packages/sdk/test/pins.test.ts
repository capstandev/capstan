// R9: PINS equal the server's /v1/venues builder addresses and caps; any difference refuses with DEPLOYMENT_MISMATCH.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { OrderIntent, VenueCapabilities } from "@capstan/schema";
import { SdkError } from "../src/errors";
import { assertServerMatchesPins, PINS } from "../src/pins";
import { hlTemplateHashes, PINS_FILE, regenerate, render } from "../scripts/gen-pins";
import { hlProbeBundles } from "../scripts/hl-template";
import { hlTemplateHash } from "../src/onboard";
import { BUILDER_ASTER, BUILDER_HL, labelAddr, testPins } from "./helpers";
import { sdkClient, startStack } from "./stack";

const BUY: OrderIntent = { marketId: "hyperliquid:-:BTC", side: "buy", size: "0.001", type: "limit", limitPx: "76000", tif: "gtc", reduceOnly: false, maxSlippageBps: 50 };

describe("pins", () => {
  test("server-equality", async () => {
    const s = await startStack();
    try {
      const venues = (await (await fetch(`${s.apiBase}/venues`)).json()) as VenueCapabilities[];
      const np = testPins().networks.mainnet;
      expect(() => assertServerMatchesPins(venues, np)).not.toThrow();
      expect(venues.find((v) => v.venue === "hyperliquid")!.builderFee!.builderAddress).toBe(BUILDER_HL);
      expect(venues.find((v) => v.venue === "aster")!.builderFee!.builderAddress).toBe(BUILDER_ASTER);
      const mutate = (venue: string, f: (v: VenueCapabilities) => VenueCapabilities) => venues.map((v) => (v.venue === venue ? f(structuredClone(v)) : v));
      const cases: [VenueCapabilities[], string][] = [
        [mutate("hyperliquid", (v) => ((v.builderFee!.builderAddress = labelAddr("other")), v)), "hyperliquid.builderAddress"],
        [mutate("aster", (v) => ((v.builderFee!.builderAddress = labelAddr("other")), v)), "aster.builderAddress"],
        [mutate("hyperliquid", (v) => ((v.builderFee!.capBps = 50), v)), "hyperliquid.capBps"],
        [mutate("aster", (v) => ((v.builderFee!.chargeBps = 5), v)), "aster.chargeBps"],
        [mutate("hyperliquid", (v) => ((v.builderFee = null), v)), "hyperliquid.builderFee"],
        [mutate("hyperliquid", (v) => (((v as { canWithdraw: boolean }).canWithdraw = true), v)), "hyperliquid.canWithdraw"],
        [[...venues, { venue: "lighter-mainnet", execution: true, keyType: "lighter-native", delegation: "api_key_index", canWithdraw: false, builderFee: { kind: "lighter_integrator", unit: "ppm", capBps: 10, chargeBps: 1, approvalSignedBy: "main_wallet", builderAddress: labelAddr("li") }, collateral: ["USDC"], directSubmitSupported: true, publicAccountReads: true }], "lighter-mainnet.chargeBps"],
      ];
      for (const [v, field] of cases) {
        const e = (() => {
          try {
            assertServerMatchesPins(v, np);
            return null;
          } catch (x) {
            return x as SdkError;
          }
        })();
        expect([e?.code, e?.field]).toEqual(["DEPLOYMENT_MISMATCH", field]);
      }
      // shipped pins name no builder: a server that names one does not match this release
      expect(((): string | undefined => { try { assertServerMatchesPins(venues, PINS.networks.mainnet); } catch (x) { return (x as SdkError).field; } })()).toBe("hyperliquid.builderAddress");
    } finally {
      s.stop();
    }
    // through the client: a tampered /v1/venues stops a build before any build request is made
    const s2 = await startStack();
    try {
      const { client } = await sdkClient(s2);
      await client.onboard("hyperliquid");
      const s3 = await startStack({ tamper: { venues: (v) => v.map((x) => (x.venue === "hyperliquid" ? { ...x, builderFee: { ...x.builderFee!, builderAddress: labelAddr("swap") } } : x)) } });
      try {
        const { client: c3 } = await sdkClient(s3);
        const e = (await c3.onboard("hyperliquid").catch((x) => x)) as SdkError;
        expect(e.code).toBe("DEPLOYMENT_MISMATCH");
        // refused at the /v1/venues check: no preflight was asked and no key was made
        expect(s3.hits.some((h) => h.path === "/v1/onboarding/preflight")).toBe(false);
      } finally {
        s3.stop();
      }
      expect((await client.buildOrder(BUY, "hyperliquid", "relay")).venue).toBe("hyperliquid");
    } finally {
      s2.stop();
    }
  });

  test("generated parts of pins.json are current", async () => {
    const raw = JSON.parse(readFileSync(PINS_FILE, "utf8"));
    expect(render(regenerate(raw, await hlTemplateHashes()))).toBe(readFileSync(PINS_FILE, "utf8"));
    // eight Lighter step combinations per config and network; no builder, so no Aster hash yet
    expect(PINS.networks.mainnet.templateHashes["lighter-rh"].length).toBe(8);
    expect(PINS.networks.testnet.templateHashes["lighter-mainnet"].length).toBe(8);
    expect(PINS.networks.mainnet.templateHashes.aster).toEqual([]);
    expect(PINS.networks.mainnet.approvalCeilings).toEqual({ hyperliquid: "0.03%", aster: "0.0003" });
    expect(PINS.networks.mainnet.allowedFees).toEqual({ hyperliquid: [10, 20], aster: ["0.0001", "0.0002"] });
  });

  // The launch blocker of 2026-11-12: empty Hyperliquid pins made every production onboarding TEMPLATE_UNKNOWN.
  test("a real Hyperliquid onboarding build (plain and agent-safe) matches a pin on each network", async () => {
    const seen = new Set<string>();
    for (const net of ["mainnet", "testnet"] as const) {
      const pinned = PINS.networks[net].templateHashes.hyperliquid;
      expect(pinned.length).toBe(2);
      const { plain, policy } = await hlProbeBundles(net);
      expect(plain.steps.map((s) => s.kind)).toEqual(["eligibility_declaration", "hl_approve_agent", "hl_approve_builder_fee"]);
      expect(policy.steps.map((s) => s.kind)).toEqual(["eligibility_declaration", "hl_approve_agent", "hl_approve_builder_fee", "agent_policy"]);
      for (const b of [plain, policy]) {
        const h: string = hlTemplateHash(b).toLowerCase();
        expect(h).toBe(b.templateHash.toLowerCase());
        expect(pinned.map((x) => x.toLowerCase() as string)).toContain(h);
        seen.add(h);
      }
    }
    // the network is part of the template (hyperliquidChain stays literal): four different hashes
    expect(seen.size).toBe(4);
  });
});
