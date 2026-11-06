// R3 and R4: onboarding bundles are checked against the pins before any wallet prompt, and every onboarding uses a
// key that was never used before (locally or on the server's delegation list).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildOnboarding as asterOnboarding, onboardingTemplateHash as asterAdapterHash } from "@capstan/adapter-aster";
import { buildOnboarding as lighterOnboarding, LIGHTER_CONFIGS, onboardingTemplateHash as lighterAdapterHash } from "@capstan/adapter-lighter";
import type { Hex, OnboardingBundle, OnboardingStep } from "@capstan/schema";
import { AsterNonce } from "@capstan/signer-aster";
import { createClient } from "../src/client";
import { SdkError } from "../src/errors";
import { memoryKeyStore } from "../src/keys/memory";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { addressOfSecret } from "../src/keys/secp";
import { asterTemplateHash, checkOnboardingBundle, lighterTemplateHash } from "../src/onboard";
import { PINS } from "../src/pins";
import { AGENT, BUILDER_ASTER, BUILDER_HL, labelAddr, OWNER, T0, testPins } from "./helpers";
import { hlTemplatePin, startStack, type Tamper } from "./stack";
import { testWallet } from "./wallet-fixture";

const decl = (owner: Hex): OnboardingStep => ({ kind: "eligibility_declaration", signer: "main_wallet", typedData: { domain: { name: "CapstanEligibility", version: "1", chainId: 4663 }, types: { Declaration: [{ name: "owner", type: "address" }] }, primaryType: "Declaration", message: { owner } } });

async function clientOn(stack: Awaited<ReturnType<typeof startStack>>, pin: Hex | null, extra: Partial<Parameters<typeof createClient>[0]> = {}) {
  const wallet = testWallet();
  const ks = memoryKeyStore();
  const c = createClient({
    apiBase: stack.apiBase,
    network: "mainnet",
    keystore: ks,
    walletSigner: wallet,
    pinned: { networks: { mainnet: { ...PINS.networks.mainnet, builders: { hyperliquid: BUILDER_HL, aster: BUILDER_ASTER }, templateHashes: { ...PINS.networks.mainnet.templateHashes, hyperliquid: pin ? [pin] : [] }, receiptSigners: [{ address: stack.receiptSigner }] } } },
    venueHosts: { hyperliquid: stack.venue.url },
    now: () => T0,
    ...extra,
  });
  return { c, wallet, ks };
}

describe("onboarding", () => {
  let pin: Hex;
  const stacks: Awaited<ReturnType<typeof startStack>>[] = [];
  const stackWith = async (tamper?: Tamper, knownAgents?: string[]) => {
    const s = await startStack({ ...(tamper ? { tamper } : {}), ...(knownAgents ? { knownAgents } : {}) });
    stacks.push(s);
    return s;
  };
  beforeAll(async () => {
    const s = await stackWith();
    pin = await hlTemplatePin(s.apiBase);
  });
  afterAll(() => stacks.forEach((s) => s.stop()));

  test("template-and-pins", async () => {
    const refusals: [string, Tamper | undefined, "pin" | null, string, string][] = [
      ["unpinned template", undefined, null, "TEMPLATE_UNKNOWN", "templateHash"],
      ["other builder", { bundle: (b) => (((b.steps[2]!.typedData!.message as Record<string, unknown>).builder = labelAddr("attacker")), b) }, "pin", "PAYLOAD_MISMATCH", "hl_approve_builder_fee.builder"],
      ["higher ceiling", { bundle: (b) => (((b.steps[2]!.typedData!.message as Record<string, unknown>).maxFeeRate = "0.1%"), b) }, "pin", "TEMPLATE_UNKNOWN", "templateHash"],
      ["other agent", { bundle: (b) => (((b.steps[1]!.typedData!.message as Record<string, unknown>).agentAddress = labelAddr("attacker-agent")), b) }, "pin", "PAYLOAD_MISMATCH", "hl_approve_agent.agentAddress"],
      ["claimed hash for a changed shape", { bundle: (b) => ({ ...b, steps: [b.steps[0]!, b.steps[1]!, b.steps[2]!, { ...b.steps[2]!, kind: "hl_collateral_move" } as OnboardingStep], humanReadable: [...b.humanReadable, "Move funds."] }) }, "pin", "TEMPLATE_UNKNOWN", "templateHash"],
      ["builder step dropped", { bundle: (b) => ({ ...b, steps: b.steps.slice(0, 2), humanReadable: b.humanReadable.slice(0, 2) }) }, "pin", "TEMPLATE_UNKNOWN", "templateHash"],
    ];
    for (const [name, tamper, p, code, field] of refusals) {
      const s = await stackWith(tamper);
      const { c, wallet, ks } = await clientOn(s, p === "pin" ? pin : null);
      const e = await c.onboard("hyperliquid").catch((x) => x);
      expect(e).toBeInstanceOf(SdkError);
      if ((e as SdkError).code !== code || (e as SdkError).field !== field) throw new Error(`${name}: got ${(e as SdkError).code} ${(e as SdkError).field}`);
      // refused before any wallet prompt, and the unused key is wiped
      expect(wallet.prompts).toEqual([]);
      expect(wallet.shown).toEqual([]);
      expect(await ks.list()).toEqual([]);
      expect(s.venue.st.exchangePosts).toEqual([]);
    }
    // a pinned builder that differs from the server's /v1/venues refuses before the bundle is even asked for
    const s = await stackWith({ venues: (v) => v.map((x) => (x.venue === "hyperliquid" ? { ...x, builderFee: { ...x.builderFee!, builderAddress: labelAddr("other-builder") } } : x)) });
    const { c, wallet } = await clientOn(s, pin);
    const e = (await c.onboard("hyperliquid").catch((x) => x)) as SdkError;
    expect([e.code, e.field]).toEqual(["DEPLOYMENT_MISMATCH", "hyperliquid.builderAddress"]);
    expect(wallet.prompts).toEqual([]);
    expect(s.hits.some((h) => h.path.endsWith("/onboarding/build"))).toBe(false);
  });

  test("fresh-key", async () => {
    const s = await stackWith();
    const { c, ks } = await clientOn(s, pin);
    const a = await c.onboard("hyperliquid");
    const b = await c.onboard("hyperliquid");
    expect(a.agentRef).not.toBe(b.agentRef);
    const parts = (await ks.list()).map((k) => k.publicPart);
    expect(new Set(parts).size).toBe(2);

    // a store whose RNG repeats: the second key would equal the first, so it is refused, never reused
    const seed = new Uint8Array(48).fill(7);
    const fixed = memoryKeyStore({ random: (n) => (n === 48 ? seed.slice() : crypto.getRandomValues(new Uint8Array(n))) });
    const s2 = await stackWith();
    const { c: c2 } = await clientOn(s2, pin, { keystore: fixed });
    await c2.onboard("hyperliquid");
    const e = (await c2.onboard("hyperliquid").catch((x) => x)) as SdkError;
    expect(e.code).toBe("KEY_REUSED");
    expect((await fixed.list()).length).toBe(1);

    // an address on the server's delegation list is never used: the SDK makes another key
    const repeat = addressOfSecret(secp256k1.utils.randomSecretKey(seed));
    let first = true;
    const flaky = memoryKeyStore({ random: (n) => (n === 48 && first ? ((first = false), seed.slice()) : crypto.getRandomValues(new Uint8Array(n))) });
    const s3 = await stackWith(undefined, [repeat]);
    const { c: c3, ks: _k } = await clientOn(s3, pin, { keystore: flaky });
    const r = await c3.onboard("hyperliquid");
    expect(r.agentRef).not.toBe(`hl:${repeat}`);
    expect((await flaky.usedPublicParts!()).includes(repeat)).toBe(true); // made, refused, tombstoned
    expect((await flaky.list()).map((k) => k.publicPart)).not.toContain(repeat);
  });

  test("aster bundle: pinned template, perp only, no withdraw, pinned builder and ceiling", () => {
    const pins = testPins({ templateHashes: { aster: [asterTemplateHash(BUILDER_ASTER, "Mainnet", "0.0003")] } });
    // the SDK's own template formula equals the adapter's
    expect(asterTemplateHash(BUILDER_ASTER, "Mainnet", "0.0003")).toBe(asterAdapterHash(BUILDER_ASTER, "Mainnet"));
    expect(asterTemplateHash(BUILDER_ASTER, "Testnet", "0.0003")).toBe(asterAdapterHash(BUILDER_ASTER, "Testnet"));
    const mk = () => asterOnboarding({ owner: OWNER, agentAddress: AGENT, mode: "relay", network: "Mainnet", nowMs: T0 }, { relayEgressIp: "203.0.113.7", builder: BUILDER_ASTER, nonce: new AsterNonce(), serverTimeMs: T0, eligibilityStep: decl(OWNER) });
    const ctx = { venue: "aster" as const, network: "mainnet" as const, pins, owner: OWNER, agentAddress: AGENT, nowMs: T0 };
    const ok = checkOnboardingBundle(mk(), ctx);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.lines.join(" ")).toContain("at most 0.0003 (3 bps)");
    const tamper = (f: (b: OnboardingBundle) => void) => {
      const b = structuredClone(mk());
      f(b);
      return checkOnboardingBundle(b, ctx);
    };
    const params = (b: OnboardingBundle, i: number) => (b.steps[i]!.venueTx as { params: [string, unknown][] }).params;
    expect(tamper((b) => (params(b, 1).find(([k]) => k === "canWithdraw")![1] = true))).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "aster_approve_agent.permissions" });
    expect(tamper((b) => (params(b, 2).find(([k]) => k === "builder")![1] = labelAddr("attacker")))).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "aster_approve_builder.builder" });
    expect(tamper((b) => (params(b, 2).find(([k]) => k === "maxFeeRate")![1] = "0.001"))).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "aster_approve_builder.maxFeeRate" });
    expect(tamper((b) => ((b.steps[1]!.typedData!.message as Record<string, unknown>).CanSpotTrade = true))).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "aster_approve_agent.typedData" });
    expect(tamper((b) => (b.templateHash = `0x${"22".repeat(32)}` as Hex))).toEqual({ ok: false, code: "TEMPLATE_UNKNOWN", field: "templateHash" });
    expect(checkOnboardingBundle(mk(), { ...ctx, pins: testPins() })).toEqual({ ok: false, code: "TEMPLATE_UNKNOWN", field: "templateHash" });
  });

  test("lighter bundle: pinned template, the local key, the exact registration text, zero fees", async () => {
    const pub = `0x${"ab".repeat(40)}`;
    const reader = { accountIndexByL1: async () => ({ main: 712, subs: [] }), apiKeys: async () => [], nextNonce: async () => 3 } as never;
    const mk = (integ: number | null) => lighterOnboarding({ owner: OWNER, lighterPubKey: pub, config: LIGHTER_CONFIGS.mainnet }, { reader, integratorAccountIndex: integ, nowMs: T0, eligibilityStep: decl(OWNER) });
    for (const kinds of [["lighter_change_pubkey"], ["eligibility_declaration", "lighter_change_pubkey"], ["eligibility_declaration", "lighter_change_pubkey", "lighter_approve_integrator", "agent_policy"]]) {
      expect(lighterTemplateHash("lighter-mainnet", 304, kinds)).toBe(lighterAdapterHash(LIGHTER_CONFIGS.mainnet, kinds));
      expect(lighterTemplateHash("lighter-rh", 466324, kinds)).toBe(lighterAdapterHash(LIGHTER_CONFIGS.rh, kinds));
    }
    // the shipped pins carry the Lighter hashes (generated by scripts/gen-pins.ts)
    expect(PINS.networks.mainnet.templateHashes["lighter-mainnet"]).toContain(lighterTemplateHash("lighter-mainnet", 304, ["eligibility_declaration", "lighter_change_pubkey"]));
    const ctx = { venue: "lighter-mainnet" as const, network: "mainnet" as const, pins: PINS, owner: OWNER, lighterPubKey: pub, nowMs: T0 };
    const b = await mk(null);
    expect(checkOnboardingBundle(b, ctx).ok).toBe(true);
    expect(checkOnboardingBundle(b, { ...ctx, lighterPubKey: `0x${"cd".repeat(40)}` })).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "lighter_change_pubkey.pubKey" });
    const t = structuredClone(b);
    t.steps[1]!.personalSignText = t.steps[1]!.personalSignText!.replace("Only sign", "Sign");
    expect(checkOnboardingBundle(t, ctx)).toEqual({ ok: false, code: "PAYLOAD_MISMATCH", field: "lighter_change_pubkey.text" });
    // an integrator step while this release pins no integrator index: refused
    const withInteg = await mk(4242);
    expect(checkOnboardingBundle(withInteg, ctx)).toEqual({ ok: false, code: "DEPLOYMENT_MISMATCH", field: "lighter_approve_integrator.integratorAccountIndex" });
    expect(checkOnboardingBundle(withInteg, { ...ctx, pins: testPins({ lighterIntegratorIndex: { "lighter-mainnet": 4242 } }) }).ok).toBe(true);
  });
});
