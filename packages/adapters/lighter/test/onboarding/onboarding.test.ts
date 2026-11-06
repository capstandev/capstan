// R2 (message equals the WASM messageToSign byte for byte and the human line names the exchange), R3 (L1Sig is the
// owner's 65-byte personal_sign, anything else refused), R4 (integrator approval at zero fees only), R15 (maker-only
// keys only for Premium, and off until proven).
import { afterAll, describe, expect, test } from "bun:test";
import { CapstanError, type Hex, type OnboardingBundle } from "@capstan/schema";
import { createLighterSigner, type LighterSigner } from "@capstan/signer-lighter-wasm";
import { createMemoryGovernor, fakeVenueServer, venueHttp } from "@capstan/venue-client";
import { assertZeroFeeApproval, buildOnboarding, changePubKeyMessage, LIGHTER_CONFIGS, submitOnboarding, type ApproveIntegratorVenueTx, type ChangePubKeyVenueTx, type LighterConfig } from "../../src";
import { NOW, otherWallet, ownerWallet } from "../build-helpers";
import { json } from "../helpers";

const signers: LighterSigner[] = [];
const servers: { stop(): void }[] = [];
afterAll(() => {
  signers.forEach((s) => s.close());
  servers.forEach((s) => s.stop());
});

const stubReader = (used: number[] = [0, 1, 2, 3], nonce = 0) => ({
  accountIndexByL1: async () => ({ main: 99, subAccounts: [] }),
  apiKeys: async () => used.map((i) => ({ apiKeyIndex: i, publicKey: "ab".repeat(40) })),
  nextNonce: async () => nonce,
});

async function newKey(chainId: 304 | 466324) {
  const s = await createLighterSigner(chainId);
  signers.push(s);
  return { s, pub: s.generateApiKey().publicKey };
}

async function bundleFor(cfg: Readonly<LighterConfig>, pub: string, integrator: number | null = null): Promise<OnboardingBundle> {
  return buildOnboarding({ owner: ownerWallet.address as Hex, lighterPubKey: pub, config: cfg }, { reader: stubReader(), integratorAccountIndex: integrator, nowMs: NOW });
}

function sendTxServer() {
  const sent: { tx_type: string; tx_info: string }[] = [];
  const srv = fakeVenueServer({
    "POST /api/v1/sendTx": async (req) => {
      const f = new URLSearchParams(await req.text());
      sent.push({ tx_type: f.get("tx_type")!, tx_info: f.get("tx_info")! });
      return json({ code: 200, message: "", tx_hash: "ab".repeat(40) });
    },
  });
  servers.push(srv);
  return { srv, sent, http: venueHttp("lighter-304", srv.url, createMemoryGovernor("t")) };
}

describe("onboarding", () => {
  test("message-and-exchange-name", async () => {
    for (const [cfg, name] of [
      [LIGHTER_CONFIGS.mainnet, "Lighter mainnet"],
      [LIGHTER_CONFIGS.rh, "Lighter on Robinhood Chain"],
    ] as const) {
      const { s, pub } = await newKey(cfg.signingChainId as 304 | 466324);
      const b = await bundleFor(cfg, pub);
      const step = b.steps.find((x) => x.kind === "lighter_change_pubkey")!;
      expect(step.signer).toBe("main_wallet");
      const tx = step.venueTx as ChangePubKeyVenueTx;
      expect(tx.args.apiKeyIndex).toBe(4); // lowest free, never 0-3
      const signed = await s.signChangePubKey({ pubKeyHex: tx.args.pubKeyHex, nonce: tx.args.nonce, apiKeyIndex: tx.args.apiKeyIndex, accountIndex: tx.args.accountIndex, expiredAt: tx.args.expiredAt });
      expect(step.personalSignText).toBe(signed.messageToSign); // byte for byte
      expect(changePubKeyMessage(pub, 0, 99, 4)).toBe(signed.messageToSign);
      // the L1 message carries no chain id and no exchange name, so the human line names the exchange
      expect(signed.messageToSign.includes("Lighter mainnet") || signed.messageToSign.includes("Robinhood")).toBe(false);
      expect(b.humanReadable.some((l) => l.includes(name))).toBe(true);
      expect(b.venue).toBe(cfg.venue);
      expect(b.templateHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(b.expiresAt).toBeLessThan(tx.args.expiredAt);
    }
    // the two exchanges never share a template hash
    const { pub } = await newKey(304);
    expect((await bundleFor(LIGHTER_CONFIGS.mainnet, pub)).templateHash).not.toBe((await bundleFor(LIGHTER_CONFIGS.rh, pub)).templateHash);
  });

  test("l1sig-recovers-owner", async () => {
    const cfg = LIGHTER_CONFIGS.mainnet;
    const { s, pub } = await newKey(304);
    const b = await bundleFor(cfg, pub);
    const idx = b.steps.findIndex((x) => x.kind === "lighter_change_pubkey");
    const step = b.steps[idx]!;
    const tx = step.venueTx as ChangePubKeyVenueTx;
    const l2 = await s.signChangePubKey({ pubKeyHex: tx.args.pubKeyHex, nonce: tx.args.nonce, apiKeyIndex: tx.args.apiKeyIndex, accountIndex: tx.args.accountIndex, expiredAt: tx.args.expiredAt });
    const good = await ownerWallet.signMessage({ message: step.personalSignText! });
    const bad = await otherWallet.signMessage({ message: step.personalSignText! });
    const { http, sent } = sendTxServer();
    const input = (sig: Hex, txInfo = l2.txInfo) => ({ bundleId: b.bundleId, signatures: [{ step: idx, sig }], lighterSignedTx: { txType: 8 as const, txInfo } });
    const ctx = { bundle: b, cfg, nowMs: NOW };
    // a signature by another wallet, a short signature, or a tampered L2 tx: refused, nothing sent
    await expect(submitOnboarding(input(bad), http, ctx)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(submitOnboarding(input(good.slice(0, 66) as Hex), http, ctx)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const other = await s.signChangePubKey({ pubKeyHex: tx.args.pubKeyHex, nonce: tx.args.nonce + 1, apiKeyIndex: tx.args.apiKeyIndex, accountIndex: tx.args.accountIndex, expiredAt: tx.args.expiredAt });
    await expect(submitOnboarding(input(good, other.txInfo), http, ctx)).rejects.toMatchObject({ code: "PAYLOAD_MISMATCH", field: "Nonce" });
    await expect(submitOnboarding(input(good), http, { ...ctx, nowMs: b.expiresAt + 1 })).rejects.toMatchObject({ code: "BUILD_EXPIRED" });
    expect(sent.length).toBe(0);
    // the owner's signature goes into L1Sig and the tx is sent as type 8
    const r = await submitOnboarding(input(good), http, ctx);
    expect(sent.length).toBe(1);
    expect(sent[0]!.tx_type).toBe("8");
    const info = JSON.parse(sent[0]!.tx_info);
    expect(info.L1Sig).toBe(good);
    expect(info.L1Sig.length).toBe(132); // 65 bytes
    expect(info.Sig).toBe(JSON.parse(l2.txInfo).Sig); // the new key's L2 signature is untouched
    expect(r.agentRef).toBe(`lighter-mainnet:99:${tx.args.apiKeyIndex}`);
  });

  test("zero-fee-integrator", async () => {
    const cfg = LIGHTER_CONFIGS.rh;
    const { s, pub } = await newKey(466324);
    const b = await bundleFor(cfg, pub, 18971);
    const ai = b.steps.find((x) => x.kind === "lighter_approve_integrator")!;
    expect(ai.signer).toBe("delegated_key"); // no L1 signature at zero fees
    expect(ai.personalSignText).toBeUndefined();
    const tx = ai.venueTx as ApproveIntegratorVenueTx;
    expect(tx.args).toMatchObject({ integratorAccountIndex: 18971, maxPerpsTakerFee: 0, maxPerpsMakerFee: 0, maxSpotTakerFee: 0, maxSpotMakerFee: 0 });
    expect(() => assertZeroFeeApproval({ ...tx.args, maxPerpsTakerFee: 1 })).toThrow(CapstanError);
    // the signer refuses non-zero fees too (todo 10 R10)
    await expect(s.signApproveIntegrator({ ...tx.args, maxSpotMakerFee: 5 as 0 })).rejects.toThrow();
    // a submitted approval with a fee above zero is refused before it is sent
    const cpkIdx = b.steps.findIndex((x) => x.kind === "lighter_change_pubkey");
    const cpk = b.steps[cpkIdx]!.venueTx as ChangePubKeyVenueTx;
    const l2 = await s.signChangePubKey({ ...cpk.args });
    const good = await ownerWallet.signMessage({ message: b.steps[cpkIdx]!.personalSignText! });
    const approve = await s.signApproveIntegrator({ ...tx.args });
    const tampered = JSON.stringify({ ...JSON.parse(approve.txInfo), MaxPerpsTakerFee: 100 });
    const { http, sent } = sendTxServer();
    const base = { bundleId: b.bundleId, signatures: [{ step: cpkIdx, sig: good }], lighterSignedTx: { txType: 8 as const, txInfo: l2.txInfo } };
    await expect(submitOnboarding({ ...base, lighterSignedApproveIntegrator: { txType: 45, txInfo: tampered } }, http, { bundle: b, cfg, nowMs: NOW })).rejects.toThrow(/must be 0/);
    expect(sent.length).toBe(0); // nothing goes to the venue when any part is wrong
    const ok = await submitOnboarding({ ...base, lighterSignedApproveIntegrator: { txType: 45, txInfo: approve.txInfo } }, http, { bundle: b, cfg, nowMs: NOW });
    expect(ok.venueResponses.length).toBe(2);
    expect(sent.map((x) => x.tx_type)).toEqual(["8", "45"]);
  });

  test("maker-only-premium-only", async () => {
    const { pub } = await newKey(304);
    const req = (tier: "standard" | "plus" | "premium") => ({ owner: ownerWallet.address as Hex, lighterPubKey: pub, config: LIGHTER_CONFIGS.mainnet, makerOnly: true, accountTier: tier });
    for (const tier of ["standard", "plus"] as const) {
      const e = await buildOnboarding(req(tier), { reader: stubReader(), integratorAccountIndex: null, nowMs: NOW, env: {} }).catch((x) => x);
      expect(e).toBeInstanceOf(CapstanError);
      expect((e as CapstanError).code).toBe("INVALID_INPUT");
      expect((e as CapstanError).message).toContain("Premium");
    }
    // Premium stays behind LIGHTER_MAKER_ONLY=0 until the format is proven on testnet (BACKLOG A3)
    await expect(buildOnboarding(req("premium"), { reader: stubReader(), integratorAccountIndex: null, nowMs: NOW, env: { LIGHTER_MAKER_ONLY: "0" } })).rejects.toThrow(/not offered yet/);
    const b = await buildOnboarding(req("premium"), { reader: stubReader(), integratorAccountIndex: null, nowMs: NOW, env: { LIGHTER_MAKER_ONLY: "1" } });
    expect(b.humanReadable[0]).toContain("Maker-only");
    // a normal key needs no tier
    expect((await buildOnboarding({ ...req("standard"), makerOnly: false }, { reader: stubReader(), integratorAccountIndex: null, nowMs: NOW, env: {} })).steps.length).toBe(1);
  });
});
