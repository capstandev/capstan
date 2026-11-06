// Hyperliquid onboarding (spec 4.1 steps 1 to 3, 7.2; venue-hyperliquid.md sections 4 to 7): preflight, bundle build,
// submit, verify. Onboarding is not complete until the MAIN wallet has signed the builder-fee approval: a bundle
// without that step cannot be built, and a builder approval signed by any other key is refused at submit.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ulid } from "@capstan/core";
import { CapstanError, type DelegationState, type ErrorCode, type Hex, type OnboardingBundle, type OnboardingRequest, type OnboardingResult, type OnboardingStep, type SignedOnboarding, type VenueIdentity } from "@capstan/schema";
import { agentNameWithExpiry, DEFAULT_MAX_FEE_RATE, feeRateToTenthsBp, fromHex, hashTypedPayload, MAX_AGENT_VALIDITY_MS, postBody, recoverSigner, sigToHl, type HlNetwork, type HlUserAction } from "@capstan/signer-hl";
import type { VenueHttp } from "@capstan/venue-client";
import type { HlReader } from "./read";
import { approveAgentStep, approveBuilderFeeStep, collateralMoveStep, templateHash } from "./templates";

export { HL_TEMPLATE_VERSION, templateHash } from "./templates";

/** Named agent slots per account (venue docs). Live data shows more on some accounts: kept at the docs value. */
export const HL_NAMED_AGENT_SLOTS = 3;
export const HL_MAX_BUILDER_APPROVALS = 10;
export const HL_BUILDER_MAX_BPS = 3;
/** maxBuilderFee below this (tenths of a bp) cannot carry the f=20 charge. */
export const HL_MIN_APPROVED_TENTHS_BP = 20;
export const DEFAULT_AGENT_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;
export const BUNDLE_LIFETIME_MS = 15 * 60 * 1000;
export const DEFAULT_SIGNATURE_CHAIN_ID: Hex = "0xa4b1";

export class HlOnboardingError extends CapstanError {
  readonly help: string;
  constructor(code: ErrorCode, message: string, help: string) {
    super(code, message);
    this.help = help;
  }
}

export interface HlPreflight {
  slotsFree: number;
  namedAgents: { name: string; address: Hex; validUntil: number | null }[];
  builderApprovedTenthsBp: number;
  approvalsCount: number;
  approvalsFull: boolean;
  depositRequired: false;
  dexCollateral: Record<string, { asset: string; balance: string }>;
}

export async function preflight(r: HlReader, owner: Hex, builder: Hex, nowMs: number = Date.now()): Promise<HlPreflight> {
  const o = owner.toLowerCase() as Hex;
  const b = builder.toLowerCase() as Hex;
  const agents = await r.extraAgents(o);
  // expired agents are pruned by the venue and free their slot
  const active = agents.filter((a) => a.validUntil === null || a.validUntil > nowMs);
  const approved = await r.approvedBuilders(o);
  const mbf = await r.maxBuilderFee(o, b);
  const dexCollateral: HlPreflight["dexCollateral"] = {};
  for (const dex of await r.accountDexes()) {
    const acct = await r.dexAccount(o, dex);
    dexCollateral[dex ?? ""] = { asset: acct.collateralAsset, balance: acct.withdrawable };
  }
  return {
    slotsFree: Math.max(0, HL_NAMED_AGENT_SLOTS - active.length),
    namedAgents: active,
    builderApprovedTenthsBp: mbf,
    approvalsCount: approved.length,
    approvalsFull: approved.length >= HL_MAX_BUILDER_APPROVALS && !approved.includes(b),
    depositRequired: false,
    dexCollateral,
  };
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** `cpst-` + the first 6 base32 characters (RFC 4648, lowercase) of keccak256(agent address bytes). */
export function capstanAgentName(agentAddress: Hex): string {
  const h = keccak_256(fromHex(agentAddress.toLowerCase()));
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of h) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 6) {
      out += B32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 6) break;
  }
  return `cpst-${out}`;
}

export function shortAddr(a: Hex): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface HlCollateralMove {
  toDex: string;
  token: string;
  amount: string;
  /** Only the owner is allowed. Present so a request that names another address is refused, not ignored. */
  destination?: Hex;
}

export type HlOnboardingRequest = OnboardingRequest & {
  agentAddress: Hex;
  builderMaxBps: number;
  network: HlNetwork;
  signatureChainId?: Hex;
  agentValidUntilMs?: number;
  collateralMoves?: HlCollateralMove[];
};

export interface HlOnboardingContext {
  reader: HlReader;
  builder: Hex;
  nowMs: number;
  /** Eligibility declaration step (todo 23). Always the first step. */
  declarationStep: (req: HlOnboardingRequest) => Promise<OnboardingStep> | OnboardingStep;
  /** Optional agent-policy step (todo 22) when the request carries a policy. */
  policyStep?: (req: HlOnboardingRequest) => Promise<OnboardingStep | null> | OnboardingStep | null;
  /** Delegations lookup: true when this agent address was ever used for this owner (never reuse an agent). */
  agentSeenBefore?: (owner: Hex, agentAddress: Hex) => Promise<boolean> | boolean;
  preflight?: HlPreflight;
}

/** A Hyperliquid onboarding bundle is incomplete without the main-wallet builder approval at 0.03% (spec 7.2). */
export function assertHasBuilderApproval(steps: OnboardingStep[]): void {
  const ok = steps.some((s) => s.kind === "hl_approve_builder_fee" && s.signer === "main_wallet" && s.typedData?.message.maxFeeRate === DEFAULT_MAX_FEE_RATE);
  if (!ok) throw new CapstanError("BUILDER_APPROVAL_REQUIRED", "a Hyperliquid bundle needs the main-wallet builder approval");
}

const isAddr = (a: unknown): a is Hex => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const TOKEN_RE = /^[A-Za-z0-9]{1,16}(:0x[0-9a-fA-F]{32})?$/;
const AMOUNT_RE = /^\d+(\.\d{1,8})?$/;

export async function buildOnboarding(req: HlOnboardingRequest, ctx: HlOnboardingContext): Promise<OnboardingBundle> {
  if (req.venue !== "hyperliquid") throw new CapstanError("UNSUPPORTED_VENUE");
  if (!isAddr(req.owner) || !isAddr(req.agentAddress) || !isAddr(ctx.builder)) throw new CapstanError("INVALID_INPUT", "owner, agent and builder must be addresses");
  const owner = req.owner.toLowerCase() as Hex;
  const agent = req.agentAddress.toLowerCase() as Hex;
  const builder = ctx.builder.toLowerCase() as Hex;
  if (req.network !== "Mainnet" && req.network !== "Testnet") throw new CapstanError("INVALID_INPUT", "network must be Mainnet or Testnet");
  // The builder wallet stays in standard abstraction and is never onboarded itself.
  if (owner === builder) throw new CapstanError("INVALID_INPUT", "the builder wallet cannot be onboarded");
  if (agent === owner || agent === builder) throw new CapstanError("INVALID_INPUT", "the agent must be a fresh key, not the owner or the builder");
  if (req.builderMaxBps === undefined || req.builderMaxBps > HL_BUILDER_MAX_BPS) throw new CapstanError("INVALID_INPUT", `the builder approval ceiling is ${HL_BUILDER_MAX_BPS} bps`);
  if (req.builderMaxBps !== HL_BUILDER_MAX_BPS) throw new CapstanError("INVALID_INPUT", `the builder approval must be exactly ${HL_BUILDER_MAX_BPS} bps (0.03%)`);
  if (ctx.agentSeenBefore && (await ctx.agentSeenBefore(owner, agent))) throw new CapstanError("INVALID_INPUT", "this agent address was used before; generate a new key");

  const pf = ctx.preflight ?? (await preflight(ctx.reader, owner, builder, ctx.nowMs));
  if (pf.namedAgents.some((a) => a.address.toLowerCase() === agent)) throw new CapstanError("INVALID_INPUT", "this agent address is already registered; generate a new key");
  if (pf.slotsFree <= 0)
    throw new HlOnboardingError(
      "HL_AGENT_SLOTS_FULL",
      `All ${HL_NAMED_AGENT_SLOTS} named agent slots are in use.`,
      "Open Hyperliquid with your main wallet, go to API, and remove an agent you no longer use. Then start again.",
    );
  if (pf.approvalsFull)
    throw new HlOnboardingError(
      "HL_BUILDER_APPROVALS_FULL",
      `This account already has ${HL_MAX_BUILDER_APPROVALS} builder approvals.`,
      "Revoke a builder approval you no longer use from your main wallet on Hyperliquid, then start again.",
    );

  const now = ctx.nowMs;
  const validUntil = req.agentValidUntilMs ?? req.expiresAt ?? now + DEFAULT_AGENT_VALIDITY_MS;
  if (validUntil - now > MAX_AGENT_VALIDITY_MS) throw new CapstanError("INVALID_INPUT", "the agent can be valid for at most 180 days");
  const base = capstanAgentName(agent);
  const agentName = agentNameWithExpiry(base, validUntil, now);
  const sigChain = req.signatureChainId ?? DEFAULT_SIGNATURE_CHAIN_ID;
  let nonce = now;
  const next = () => nonce++;

  const steps: OnboardingStep[] = [];
  const lines: string[] = [];
  const decl = await ctx.declarationStep(req);
  if (decl.kind !== "eligibility_declaration") throw new CapstanError("INTERNAL_ERROR", "the first step must be the eligibility declaration");
  steps.push(decl);
  lines.push("Confirm the eligibility declaration with your wallet.");

  steps.push(approveAgentStep({ network: req.network, signatureChainId: sigChain, nonce: next(), agentAddress: agent, agentName }));
  lines.push(`Allow agent ${base} (${shortAddr(agent)}) to trade on Hyperliquid until ${day(validUntil)}. It cannot withdraw.`);

  steps.push(approveBuilderFeeStep({ network: req.network, signatureChainId: sigChain, nonce: next(), builder, maxFeeRate: DEFAULT_MAX_FEE_RATE }));
  lines.push(`Allow Capstan to charge up to ${DEFAULT_MAX_FEE_RATE} per trade on Hyperliquid (builder ${builder}).`);

  for (const mv of req.collateralMoves ?? []) {
    if (mv.destination !== undefined && mv.destination.toLowerCase() !== owner) throw new CapstanError("INVALID_INPUT", "a collateral move can only go to your own account");
    if (typeof mv.toDex !== "string" || !/^[a-z0-9]{1,8}$/.test(mv.toDex)) throw new CapstanError("INVALID_INPUT", "toDex must be a HIP-3 dex name");
    if (!TOKEN_RE.test(mv.token)) throw new CapstanError("INVALID_INPUT", "token must look like USDC or NAME:0x<16-byte id>");
    if (!AMOUNT_RE.test(mv.amount) || /^0+(\.0+)?$/.test(mv.amount)) throw new CapstanError("INVALID_INPUT", "amount must be a positive decimal");
    const step = collateralMoveStep({ network: req.network, signatureChainId: sigChain, nonce: next(), owner, toDex: mv.toDex, token: mv.token, amount: mv.amount });
    if ((step.typedData!.message.destination as string).toLowerCase() !== owner) throw new CapstanError("INTERNAL_ERROR", "collateral move destination is not the owner");
    steps.push(step);
    lines.push(`Move ${mv.amount} ${mv.token.split(":")[0]} from your core Hyperliquid account to your ${mv.toDex} account. It stays in your own account.`);
  }

  if (ctx.policyStep) {
    const p = await ctx.policyStep(req);
    if (p) {
      if (p.kind !== "agent_policy") throw new CapstanError("INTERNAL_ERROR", "the policy step must be agent_policy");
      steps.push(p);
      lines.push("Sign the agent policy that limits what the agent may do.");
    }
  }

  assertHasBuilderApproval(steps);
  const draft = { venue: "hyperliquid" as const, steps };
  return {
    bundleId: ulid(now),
    venue: "hyperliquid",
    owner,
    steps,
    humanReadable: lines,
    templateHash: templateHash(draft),
    expiresAt: now + BUNDLE_LIFETIME_MS,
  };
}

/** HL step kinds posted to /exchange, in bundle order. */
export const HL_POSTED_KINDS = new Set<OnboardingStep["kind"]>(["hl_approve_agent", "hl_approve_builder_fee", "hl_collateral_move", "revoke_agent", "revoke_builder"]);

export interface SubmitOnboardingContext {
  bundle: OnboardingBundle;
  nowMs?: number;
}

function hlAccepted(resp: unknown): boolean {
  return !!resp && typeof resp === "object" && (resp as { status?: unknown }).status === "ok";
}

/**
 * Forward each signed main-wallet step to /exchange in bundle order. Every HL signature must recover to the owner:
 * a builder approval signed by the agent (or anyone else) is refused before anything is sent. POSTs are never
 * retried; the first venue refusal stops the run and is returned.
 */
export async function submitOnboarding(signed: SignedOnboarding, http: VenueHttp, ctx: SubmitOnboardingContext): Promise<OnboardingResult> {
  const b = ctx.bundle;
  if (signed.bundleId !== b.bundleId) throw new CapstanError("INVALID_INPUT", "the signatures are for another bundle");
  if ((ctx.nowMs ?? Date.now()) > b.expiresAt) throw new CapstanError("BUILD_EXPIRED", "the onboarding bundle has expired; build it again");
  if (b.steps.some((s) => s.kind === "hl_approve_agent")) assertHasBuilderApproval(b.steps);
  const sigs = new Map(signed.signatures.map((s) => [s.step, s.sig]));
  const agentStep = b.steps.find((s) => s.kind === "hl_approve_agent" || s.kind === "revoke_agent");
  const agentAddress = (agentStep?.typedData?.message.agentAddress as Hex | undefined) ?? null;
  // verify every HL step first, so nothing is sent unless all of them are good
  const plan: { i: number; body: unknown }[] = [];
  b.steps.forEach((step, i) => {
    if (!HL_POSTED_KINDS.has(step.kind)) return;
    if (step.signer !== "main_wallet") throw new CapstanError("INVALID_INPUT", `step ${i} must be signed by the main wallet`);
    const raw = sigs.get(i);
    if (!raw) throw new CapstanError("INVALID_INPUT", `step ${i} (${step.kind}) is not signed`);
    const sig = sigToHl(raw as Hex);
    const signer = recoverSigner(hashTypedPayload(step.typedData!), sig).toLowerCase();
    if (agentAddress && signer === agentAddress.toLowerCase()) throw new CapstanError("UNAUTHORIZED", `step ${i} (${step.kind}) was signed by the agent key; only the main wallet may sign it`);
    if (signer !== b.owner.toLowerCase()) throw new CapstanError("UNAUTHORIZED", `step ${i} (${step.kind}) is not signed by the owner`);
    const tx = step.venueTx as { action: Record<string, unknown>; nonce: number };
    const action = { ...(step.typedData!.message as Record<string, unknown>), type: tx.action.type, signatureChainId: tx.action.signatureChainId } as unknown as HlUserAction;
    if (tx.action.type === "approveAgent" && !("agentName" in tx.action)) (action as { agentName: string }).agentName = "";
    plan.push({ i, body: postBody(action, sig, tx.nonce) });
  });
  const venueResponses: unknown[] = [];
  for (const p of plan) {
    const resp = await http.postJson<unknown>("/exchange", p.body);
    venueResponses.push(resp);
    if (!hlAccepted(resp)) {
      const text = typeof (resp as { response?: unknown })?.response === "string" ? (resp as { response: string }).response : JSON.stringify(resp).slice(0, 200);
      throw new CapstanError("VENUE_ERROR", `step ${p.i} refused by Hyperliquid: ${text}`);
    }
  }
  const builderStep = b.steps.find((s) => s.kind === "hl_approve_builder_fee");
  const rate = String(builderStep?.typedData?.message.maxFeeRate ?? "0%");
  return {
    agentRef: agentAddress ? `hl:${agentAddress.toLowerCase()}` : `hl:${b.owner}`,
    delegation: { agentActive: true, builderMaxBps: feeRateToTenthsBp(rate) / 10, routing: feeRateToTenthsBp(rate) < HL_MIN_APPROVED_TENTHS_BP ? "fee_free_unavailable" : "ok" },
    venueResponses,
  };
}

/** Delegation state read back from the venue: the agent is active only under our name and before its expiry. */
export async function verifyOnboarding(r: HlReader, id: VenueIdentity, builder: Hex, nowMs: number = Date.now()): Promise<DelegationState> {
  if (!id.agentAddress) throw new CapstanError("INVALID_INPUT", "verifyOnboarding needs the agent address");
  const agent = id.agentAddress.toLowerCase();
  const agents = await r.extraAgents(id.owner);
  const ours = agents.find((a) => a.address.toLowerCase() === agent && a.name === capstanAgentName(agent as Hex));
  const active = !!ours && ours.validUntil !== null && ours.validUntil > nowMs;
  const mbf = await r.maxBuilderFee(id.owner, builder);
  return {
    agentActive: active,
    builderMaxBps: mbf / 10,
    ...(ours?.validUntil ? { expiresAt: new Date(ours.validUntil).toISOString() } : {}),
    routing: mbf < HL_MIN_APPROVED_TENTHS_BP ? "fee_free_unavailable" : "ok",
  };
}

