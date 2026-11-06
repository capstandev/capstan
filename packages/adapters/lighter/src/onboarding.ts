// Lighter onboarding: register a client-made API key at a free index (ChangePubKey, tx type 8), then optionally a
// zero-fee integrator approval (tx type 45). The main wallet signs ONE plain-text message (personal_sign, EIP-191);
// the new API key signs the L2 txs in the SDK. The server never sees any private key.
// The L1 message carries no chain id and no exchange name, so the human-readable line names the exchange.
import { ulid } from "@capstan/core";
import { CapstanError, type Hex, type OnboardingBundle, type OnboardingResult, type OnboardingStep, type SignedOnboarding } from "@capstan/schema";
import type { Governor, VenueHttp } from "@capstan/venue-client";
import { keccak256, recoverMessageAddress, toBytes } from "viem";
import type { LighterConfig } from "./config";
import type { LighterTier } from "./fees";
import { isUsableKeyIndex, pickKeyIndex, usedKeyIndexes } from "./keyindex";
import { TX_EXPIRY_MS, TX_TYPE } from "./orders";
import type { LighterReader } from "./read";
import { submitTx } from "./submit";
import { parseSignedBody } from "./verify";

export const ONBOARDING_TEMPLATE_VERSION = "capstan-lighter-onboarding-v1";
/** Integrator approval lasts one year; renewal is a new zero-fee approval. */
export const INTEGRATOR_APPROVAL_MS = 365 * 24 * 3600_000;

const hex16 = (n: number) => `0x${n.toString(16).padStart(16, "0")}`;

/** lighter-go types/txtypes/utils.go ChangePubKey template, byte for byte. */
export function changePubKeyMessage(pubKeyHex: string, nonce: number, accountIndex: number, apiKeyIndex: number): string {
  const pk = pubKeyHex.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{80}$/.test(pk)) throw new CapstanError("INVALID_INPUT", "the Lighter public key must be 40 bytes of hex");
  return `Register Lighter Account\n\npubkey: 0x${pk}\nnonce: ${hex16(nonce)}\naccount index: ${hex16(accountIndex)}\napi key index: ${hex16(apiKeyIndex)}\nOnly sign this message for a trusted client!`;
}

/** The template every Lighter bundle follows; the SDK refuses a bundle whose hash it does not know. */
export function onboardingTemplateHash(cfg: Readonly<LighterConfig>, kinds: string[]): Hex {
  return keccak256(toBytes(JSON.stringify({ v: ONBOARDING_TEMPLATE_VERSION, venue: cfg.venue, signingChainId: cfg.signingChainId, kinds })));
}

export async function preflight(r: Pick<LighterReader, "accountIndexByL1" | "apiKeys">, owner: Hex): Promise<{ accountIndex: number | null; freeKeyIndex: number | null; depositRequired: boolean }> {
  const acct = await r.accountIndexByL1(owner);
  if (!acct) return { accountIndex: null, freeKeyIndex: null, depositRequired: true };
  const keys = await r.apiKeys(acct.main);
  let free: number | null;
  try {
    free = pickKeyIndex(usedKeyIndexes(keys));
  } catch {
    free = null;
  }
  return { accountIndex: acct.main, freeKeyIndex: free, depositRequired: false };
}

export interface LighterOnboardingRequest {
  owner: Hex;
  lighterPubKey: string;
  config: Readonly<LighterConfig>;
  /** Maker-only keys need a Premium account (research); off until the format is proven on testnet. */
  makerOnly?: boolean;
  accountTier?: LighterTier;
}

export interface LighterOnboardingContext {
  reader: Pick<LighterReader, "accountIndexByL1" | "apiKeys" | "nextNonce">;
  integratorAccountIndex: number | null;
  nowMs: number;
  /** Optional steps other modules make (eligibility declaration, agent policy), placed first and last. */
  eligibilityStep?: OnboardingStep;
  policyStep?: OnboardingStep;
  env?: Record<string, string | undefined>;
}

export interface ChangePubKeyVenueTx {
  txType: 8;
  args: { pubKeyHex: string; nonce: number; apiKeyIndex: number; accountIndex: number; expiredAt: number };
  signWith: "new_api_key";
}
export interface ApproveIntegratorVenueTx {
  txType: 45;
  args: { integratorAccountIndex: number; maxPerpsTakerFee: 0; maxPerpsMakerFee: 0; maxSpotTakerFee: 0; maxSpotMakerFee: 0; approvalExpiryMs: number; nonce: number; apiKeyIndex: number; accountIndex: number; expiredAt: number };
  signWith: "new_api_key";
}

function makerOnlyGate(req: LighterOnboardingRequest, env: Record<string, string | undefined>): void {
  if (!req.makerOnly) return;
  if (req.accountTier !== "premium") throw new CapstanError("INVALID_INPUT", `maker-only keys need a Premium Lighter account; this account is ${req.accountTier ?? "standard"}`);
  // TODO(owner): BACKLOG A3. The maker-only registration format is unproven; it stays off until a testnet run shows it.
  if (env.LIGHTER_MAKER_ONLY !== "1") throw new CapstanError("INVALID_INPUT", "maker-only keys are not offered yet (LIGHTER_MAKER_ONLY=0 until proven on testnet)");
}

export function approveIntegratorTx(cfg: Readonly<LighterConfig>, a: { integratorAccountIndex: number; approvalExpiryMs: number; nonce: number; apiKeyIndex: number; accountIndex: number; expiredAt: number }): ApproveIntegratorVenueTx {
  void cfg;
  return { txType: TX_TYPE.approveIntegrator, args: { ...a, maxPerpsTakerFee: 0, maxPerpsMakerFee: 0, maxSpotTakerFee: 0, maxSpotMakerFee: 0 }, signWith: "new_api_key" };
}

/** Refuse any integrator approval with a fee above zero (v1 is zero-fee attribution). */
export function assertZeroFeeApproval(args: Record<string, unknown>): void {
  for (const k of ["maxPerpsTakerFee", "maxPerpsMakerFee", "maxSpotTakerFee", "maxSpotMakerFee"]) if (args[k] !== 0) throw new CapstanError("INVALID_INPUT", `${k} must be 0 (zero-fee attribution only)`);
}

export async function buildOnboarding(req: LighterOnboardingRequest, ctx: LighterOnboardingContext): Promise<OnboardingBundle> {
  const cfg = req.config;
  makerOnlyGate(req, ctx.env ?? process.env);
  const acct = await ctx.reader.accountIndexByL1(req.owner);
  if (!acct) throw new CapstanError("LIGHTER_NO_ACCOUNT", `no ${cfg.exchangeName} account for this address: deposit at least 1 ${cfg.collateral} first`);
  const apiKeyIndex = pickKeyIndex(usedKeyIndexes(await ctx.reader.apiKeys(acct.main)));
  const nonce = await ctx.reader.nextNonce(acct.main, apiKeyIndex);
  const expiredAt = ctx.nowMs + TX_EXPIRY_MS;
  const pubKeyHex = `0x${req.lighterPubKey.replace(/^0x/i, "").toLowerCase()}`;
  const text = changePubKeyMessage(pubKeyHex, nonce, acct.main, apiKeyIndex);
  const steps: OnboardingStep[] = [];
  const human: string[] = [];
  if (ctx.eligibilityStep) {
    steps.push(ctx.eligibilityStep);
    human.push("Confirm you are eligible to trade on this venue from where you are.");
  }
  const cpk: ChangePubKeyVenueTx = { txType: TX_TYPE.changePubKey, args: { pubKeyHex, nonce, apiKeyIndex, accountIndex: acct.main, expiredAt }, signWith: "new_api_key" };
  steps.push({ kind: "lighter_change_pubkey", signer: "main_wallet", personalSignText: text, venueTx: cpk });
  human.push(
    `Register a new trading key at index ${apiKeyIndex} on ${cfg.exchangeName} (account ${acct.main}). The key can trade and cancel; it cannot send funds to another address.${req.makerOnly ? " Maker-only." : ""}`,
  );
  if (ctx.integratorAccountIndex !== null) {
    const ai = approveIntegratorTx(cfg, { integratorAccountIndex: ctx.integratorAccountIndex, approvalExpiryMs: ctx.nowMs + INTEGRATOR_APPROVAL_MS, nonce: nonce + 1, apiKeyIndex, accountIndex: acct.main, expiredAt });
    assertZeroFeeApproval(ai.args);
    steps.push({ kind: "lighter_approve_integrator", signer: "delegated_key", venueTx: ai });
    human.push(`Tag your ${cfg.exchangeName} orders with Capstan (integrator account ${ctx.integratorAccountIndex}) at 0 fees. No fee is ever charged through this approval.`);
  }
  if (ctx.policyStep) {
    steps.push(ctx.policyStep);
    human.push("Sign the agent policy that limits what this key may do through Capstan.");
  }
  return {
    bundleId: ulid(ctx.nowMs),
    venue: cfg.venue,
    owner: req.owner,
    steps,
    humanReadable: human,
    templateHash: onboardingTemplateHash(cfg, steps.map((s) => s.kind)),
    expiresAt: expiredAt - 5000,
  };
}

function b64ToHex(s: string): string | null {
  try {
    return Buffer.from(s, "base64").toString("hex");
  } catch {
    return null;
  }
}

export interface SubmitOnboardingInput extends SignedOnboarding {
  lighterSignedTx: { txType: 8; txInfo: string };
  lighterSignedApproveIntegrator?: { txType: 45; txInfo: string };
}

/**
 * Put the wallet's 65-byte personal_sign into txInfo.L1Sig after proving it recovers to the owner, check the L2 tx
 * is the one the bundle asked for, then sendTx (tx type 8, then 45 when present).
 */
export async function submitOnboarding(signed: SubmitOnboardingInput, http: VenueHttp, ctx: { bundle: OnboardingBundle; cfg: Readonly<LighterConfig>; nowMs: number; gov?: Governor }): Promise<OnboardingResult> {
  const { bundle, cfg } = ctx;
  if (signed.bundleId !== bundle.bundleId) throw new CapstanError("INVALID_INPUT", "signatures are for another bundle");
  if (ctx.nowMs > bundle.expiresAt) throw new CapstanError("BUILD_EXPIRED");
  const stepIdx = bundle.steps.findIndex((s) => s.kind === "lighter_change_pubkey");
  const step = bundle.steps[stepIdx];
  if (!step || !step.personalSignText) throw new CapstanError("INVALID_INPUT", "bundle has no key registration step");
  const want = step.venueTx as ChangePubKeyVenueTx;
  const sig = signed.signatures.find((s) => s.step === stepIdx)?.sig;
  if (!sig || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new CapstanError("UNAUTHORIZED", "the key registration needs a 65-byte wallet signature");
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message: step.personalSignText, signature: sig });
  } catch {
    throw new CapstanError("UNAUTHORIZED", "the wallet signature does not recover");
  }
  if (signer.toLowerCase() !== bundle.owner.toLowerCase()) throw new CapstanError("UNAUTHORIZED", "the wallet signature is not from the owner");

  const parsed = parseSignedBody(signed.lighterSignedTx);
  if (!parsed || parsed.txType !== TX_TYPE.changePubKey) throw new CapstanError("INVALID_INPUT", "lighterSignedTx must be a ChangePubKey tx");
  const info = parsed.info;
  const pk = typeof info.PubKey === "string" ? b64ToHex(info.PubKey) : null;
  const checks: [string, unknown, unknown][] = [
    ["AccountIndex", info.AccountIndex, want.args.accountIndex],
    ["ApiKeyIndex", info.ApiKeyIndex, want.args.apiKeyIndex],
    ["Nonce", info.Nonce, want.args.nonce],
    ["ExpiredAt", info.ExpiredAt, want.args.expiredAt],
    ["PubKey", pk, want.args.pubKeyHex.replace(/^0x/, "")],
  ];
  for (const [f, got, exp] of checks) if (got !== exp) throw new CapstanError("PAYLOAD_MISMATCH", `ChangePubKey ${f} differs from the bundle`, { field: f });
  if (!isUsableKeyIndex(want.args.apiKeyIndex)) throw new CapstanError("INVALID_INPUT", "reserved key index");
  // check the integrator approval (when sent) before anything goes to the venue
  let approve: string | null = null;
  if (signed.lighterSignedApproveIntegrator) {
    const ai = parseSignedBody(signed.lighterSignedApproveIntegrator);
    const aiStep = bundle.steps.find((s) => s.kind === "lighter_approve_integrator")?.venueTx as ApproveIntegratorVenueTx | undefined;
    if (!ai || ai.txType !== TX_TYPE.approveIntegrator || !aiStep) throw new CapstanError("INVALID_INPUT", "unexpected integrator approval");
    const i = ai.info;
    assertZeroFeeApproval({ maxPerpsTakerFee: i.MaxPerpsTakerFee, maxPerpsMakerFee: i.MaxPerpsMakerFee, maxSpotTakerFee: i.MaxSpotTakerFee, maxSpotMakerFee: i.MaxSpotMakerFee });
    for (const [f, exp] of [
      ["IntegratorAccountIndex", aiStep.args.integratorAccountIndex],
      ["ApiKeyIndex", aiStep.args.apiKeyIndex],
      ["AccountIndex", aiStep.args.accountIndex],
      ["Nonce", aiStep.args.nonce],
      ["ApprovalExpiry", aiStep.args.approvalExpiryMs],
    ] as const)
      if (i[f] !== exp) throw new CapstanError("PAYLOAD_MISMATCH", `integrator approval ${f} differs from the bundle`, { field: f });
    approve = signed.lighterSignedApproveIntegrator.txInfo;
  }
  const withL1 = JSON.stringify({ ...info, L1Sig: sig });
  const responses: unknown[] = [];
  const send = { http, cfg, ...(ctx.gov ? { gov: ctx.gov, owner: bundle.owner } : {}) };
  const r1 = await submitTx({ txType: TX_TYPE.changePubKey, txInfo: withL1 }, send);
  responses.push(r1.venueResponse);
  if (r1.status === "rejected") throw new CapstanError("VENUE_ERROR", `key registration refused: ${r1.code} ${r1.message ?? ""}`.trim());
  if (approve) responses.push((await submitTx({ txType: TX_TYPE.approveIntegrator, txInfo: approve }, send)).venueResponse);
  return {
    agentRef: `${cfg.venue}:${want.args.accountIndex}:${want.args.apiKeyIndex}`,
    delegation: { agentActive: false, builderMaxBps: 0, routing: "ok" }, // active once verifyOnboarding sees the key
    venueResponses: responses,
  };
}
