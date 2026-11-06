// Aster onboarding ceremony (spec 4.4 steps 2 to 4, 7.2; venue-aster.md sections 4.2 and 5). The MAIN wallet signs
// two Mode A messages: approveAgent (perp only, never spot, never withdraw, one IP or none, 30-day expiry) and
// approveBuilder (maxFeeRate 0.0003). The agent key is made on the user's device; Capstan never holds it (the venue's
// own demo stores it on the builder backend and sets canWithdraw true: neither is done here).
// The build takes no parameter that could turn withdraw or spot on: those values are constants in this file.
import { isIP } from "node:net";
import { ulid } from "@capstan/core";
import { CapstanError, Dec, type Hex, type OnboardingBundle, type OnboardingResult, type OnboardingStep, type SignedOnboarding } from "@capstan/schema";
import {
  AsterNonce,
  decimalString,
  digestTypedData,
  mgmtSentQuery,
  mgmtTypedData,
  recoverSigner,
  type AsterMgmtType,
  type Param,
} from "@capstan/signer-aster";
import { isUnknownOutcome, VenueHttpError, type VenueHttp } from "@capstan/venue-client";
import { keccak256, stringToBytes } from "viem";
import { ASTER_FEES, assertV3Path, type AsterNetwork } from "./config";

export const ASTER_AGENT_NAME = "capstan";
export const ASTER_BUILDER_NAME = "capstan";
export const ASTER_AGENT_TTL_MS = 30 * 86_400_000;
/** Mode A nonces are valid for 60 s around server time, so a bundle must be signed and sent inside that window. */
export const ASTER_BUNDLE_TTL_MS = 55_000;

// Fixed permission values. Not parameters anywhere.
const CAN_SPOT_TRADE = false as const;
const CAN_PERP_TRADE = true as const;
const CAN_WITHDRAW = false as const;

/** What a step sends to the venue once signed. */
export interface AsterVenueTx {
  method: "POST" | "DELETE";
  path: string;
  primaryType: AsterMgmtType;
  params: Param[];
}

export interface AsterOnboardingRequest {
  owner: Hex;
  agentAddress: Hex;
  mode: "relay" | "direct";
  directIp?: string;
  network: AsterNetwork;
  nowMs: number;
  /** Approval ceiling; default and maximum 0.0003 (3 bps). */
  maxFeeRate?: string;
}

export interface AsterOnboardingCtx {
  /** The relay's one static egress IP (RELAY_EGRESS_IP). Changing it breaks every relay-mode agent. */
  relayEgressIp: string;
  builder: Hex;
  /** Nonce state for the OWNER (the main wallet signs every Mode A step). */
  nonce: AsterNonce;
  /** Venue server time, when known, for the 60 s window check before anything is signed. */
  serverTimeMs?: number;
  /** The CapstanEligibility v1 declaration step from the eligibility module (todo 23). */
  eligibilityStep: OnboardingStep;
  /** Optional agent-safe policy step (todo 22). */
  policyStep?: OnboardingStep;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function assertAddress(a: string, field: string): Hex {
  if (!ADDR_RE.test(a)) throw new CapstanError("INVALID_INPUT", `${field} must be an address`, { field });
  return a as Hex;
}

/** Venue cap 0.001 and the brand ceiling 0.0003; plain decimal strings only. */
export function assertMaxFeeRate(rate: string): string {
  let r: string;
  try {
    r = decimalString(rate);
  } catch {
    throw new CapstanError("INVALID_INPUT", "maxFeeRate must be a plain decimal string", { field: "maxFeeRate" });
  }
  const v = Dec.parse(r, 18, "up");
  if (Dec.isZero(v)) throw new CapstanError("INVALID_INPUT", "maxFeeRate must be above zero", { field: "maxFeeRate" });
  if (Dec.cmp(v, Dec.parse(ASTER_FEES.venueCapRate, 18)) > 0) throw new CapstanError("INVALID_INPUT", "maxFeeRate is above the venue cap 0.001", { field: "maxFeeRate" });
  if (Dec.cmp(v, Dec.parse(ASTER_FEES.maxFeeRate, 18)) > 0) throw new CapstanError("INVALID_INPUT", "maxFeeRate is above the 0.0003 ceiling", { field: "maxFeeRate" });
  return r;
}

/** Exactly one IP, or empty. The venue's list delimiter for approveAgent is not settled, so a list is refused. */
export function ipWhitelistFor(mode: "relay" | "direct", relayEgressIp: string, directIp?: string): string {
  const ip = mode === "relay" ? relayEgressIp.trim() : (directIp ?? "").trim();
  if (mode === "relay" && !ip) throw new CapstanError("INVALID_INPUT", "relay mode needs the relay egress IP", { field: "relayEgressIp" });
  if (ip === "") return "";
  if (/[,\s;|]/.test(ip) || ip.includes("/")) throw new CapstanError("INVALID_INPUT", "send exactly one IP address (lists and ranges are refused)", { field: "ipWhitelist" });
  if (isIP(ip) === 0) throw new CapstanError("INVALID_INPUT", "not an IP address", { field: "ipWhitelist" });
  return ip;
}

function nonceNumber(n: AsterNonce, nowMs: number, serverTimeMs: number | undefined): number {
  const v = n.next(BigInt(nowMs) * 1000n, serverTimeMs === undefined ? undefined : BigInt(serverTimeMs) * 1000n);
  const num = Number(v);
  if (!Number.isSafeInteger(num)) throw new CapstanError("INTERNAL_ERROR", "nonce out of range");
  return num;
}

export function mgmtStep(kind: OnboardingStep["kind"], tx: AsterVenueTx): OnboardingStep {
  assertV3Path(tx.path);
  return { kind, signer: "main_wallet", typedData: mgmtTypedData(tx.primaryType, tx.params), venueTx: tx };
}

export function approveAgentTx(a: { agentAddress: Hex; ipWhitelist: string; expired: number; network: AsterNetwork; owner: Hex; nonce: number }): AsterVenueTx {
  return {
    method: "POST",
    path: "/fapi/v3/approveAgent",
    primaryType: "ApproveAgent",
    params: [
      ["agentName", ASTER_AGENT_NAME],
      ["agentAddress", a.agentAddress],
      ["ipWhitelist", a.ipWhitelist],
      ["expired", a.expired],
      ["canSpotTrade", CAN_SPOT_TRADE],
      ["canPerpTrade", CAN_PERP_TRADE],
      ["canWithdraw", CAN_WITHDRAW],
      ["asterChain", a.network],
      ["user", a.owner],
      ["nonce", a.nonce],
    ],
  };
}

export function approveBuilderTx(a: { builder: Hex; maxFeeRate: string; network: AsterNetwork; owner: Hex; nonce: number }): AsterVenueTx {
  return {
    method: "POST",
    path: "/fapi/v3/approveBuilder",
    primaryType: "ApproveBuilder",
    params: [
      ["builder", a.builder],
      ["maxFeeRate", assertMaxFeeRate(a.maxFeeRate)],
      ["builderName", ASTER_BUILDER_NAME],
      ["asterChain", a.network],
      ["user", a.owner],
      ["nonce", a.nonce],
    ],
  };
}

/**
 * Renewal: UpdateAgent with a new 30-day expiry and the same fixed permissions. The field list follows the venue's
 * updateAgent demo (VERIFY on testnet, BACKLOG A4).
 */
export function updateAgentTx(a: { agentAddress: Hex; ipWhitelist: string; expired: number; network: AsterNetwork; owner: Hex; nonce: number }): AsterVenueTx {
  return {
    method: "POST",
    path: "/fapi/v3/updateAgent",
    primaryType: "UpdateAgent",
    params: [
      ["agentAddress", a.agentAddress],
      ["ipWhitelist", a.ipWhitelist],
      ["expired", a.expired],
      ["canSpotTrade", CAN_SPOT_TRADE],
      ["canPerpTrade", CAN_PERP_TRADE],
      ["canWithdraw", CAN_WITHDRAW],
      ["asterChain", a.network],
      ["user", a.owner],
      ["nonce", a.nonce],
    ],
  };
}

/** Published per SDK release: the shape of every venue step plus every fixed value, never user data. */
export function onboardingTemplateHash(builder: Hex, network: AsterNetwork): Hex {
  const fieldTypes = (tx: AsterVenueTx) => mgmtTypedData(tx.primaryType, tx.params).types[tx.primaryType]!.map((f) => `${f.type} ${f.name}`);
  const z = "0x0000000000000000000000000000000000000000" as Hex;
  const agent = approveAgentTx({ agentAddress: z, ipWhitelist: "", expired: 0, network, owner: z, nonce: 0 });
  const bld = approveBuilderTx({ builder, maxFeeRate: ASTER_FEES.maxFeeRate, network, owner: z, nonce: 0 });
  const template = [
    "capstan-aster-onboarding-v1",
    network,
    ["aster_approve_agent", agent.path, fieldTypes(agent), ASTER_AGENT_NAME, CAN_SPOT_TRADE, CAN_PERP_TRADE, CAN_WITHDRAW, ASTER_AGENT_TTL_MS],
    ["aster_approve_builder", bld.path, fieldTypes(bld), builder.toLowerCase(), ASTER_FEES.maxFeeRate, ASTER_BUILDER_NAME],
  ];
  return keccak256(stringToBytes(JSON.stringify(template)));
}

function bps(rate: string): string {
  return Dec.toString(Dec.mul(Dec.parse(rate, 18), Dec.parse("10000", 0), 4));
}

export function buildOnboarding(req: AsterOnboardingRequest, ctx: AsterOnboardingCtx): OnboardingBundle {
  // Runtime guard as well as the type: an extra field such as canWithdraw is refused, never read.
  const allowed = new Set(["owner", "agentAddress", "mode", "directIp", "network", "nowMs", "maxFeeRate"]);
  for (const k of Object.keys(req)) if (!allowed.has(k)) throw new CapstanError("INVALID_INPUT", `unknown onboarding field ${k}`, { field: k });
  const owner = assertAddress(req.owner, "owner");
  const agentAddress = assertAddress(req.agentAddress, "agentAddress");
  const builder = assertAddress(ctx.builder, "builder");
  if (agentAddress.toLowerCase() === owner.toLowerCase()) throw new CapstanError("INVALID_INPUT", "the agent must be a new key, not the main wallet", { field: "agentAddress" });
  if (req.network !== "Mainnet" && req.network !== "Testnet") throw new CapstanError("INVALID_INPUT", "unknown network", { field: "network" });
  if (req.mode !== "relay" && req.mode !== "direct") throw new CapstanError("INVALID_INPUT", "mode must be relay or direct", { field: "mode" });
  if (ctx.eligibilityStep?.kind !== "eligibility_declaration") throw new CapstanError("INTERNAL_ERROR", "missing eligibility declaration step");
  if (ctx.policyStep && ctx.policyStep.kind !== "agent_policy") throw new CapstanError("INTERNAL_ERROR", "bad policy step");
  const ip = ipWhitelistFor(req.mode, ctx.relayEgressIp, req.directIp);
  const maxFeeRate = assertMaxFeeRate(req.maxFeeRate ?? ASTER_FEES.maxFeeRate);
  const expired = req.nowMs + ASTER_AGENT_TTL_MS;
  const agentTx = approveAgentTx({ agentAddress, ipWhitelist: ip, expired, network: req.network, owner, nonce: nonceNumber(ctx.nonce, req.nowMs, ctx.serverTimeMs) });
  const builderTx = approveBuilderTx({ builder, maxFeeRate, network: req.network, owner, nonce: nonceNumber(ctx.nonce, req.nowMs, ctx.serverTimeMs) });
  const steps: OnboardingStep[] = [ctx.eligibilityStep, mgmtStep("aster_approve_agent", agentTx), mgmtStep("aster_approve_builder", builderTx)];
  const lines = [
    "Confirm you may use this venue from where you are (eligibility declaration).",
    `Let agent ${agentAddress} trade Aster perpetuals for ${owner} until ${new Date(expired).toISOString()}. It cannot trade spot and cannot withdraw. ${ip ? `It only works from IP ${ip}${req.mode === "relay" ? " (the relay)" : ""}.` : "No IP limit is set."}`,
    `Allow builder ${builder} to charge at most ${maxFeeRate} (${bps(maxFeeRate)} bps) per Aster order.`,
  ];
  if (ctx.policyStep) {
    steps.push(ctx.policyStep);
    lines.push("Sign the agent policy that limits what the agent may do.");
  }
  return {
    bundleId: ulid(req.nowMs),
    venue: "aster",
    owner,
    steps,
    humanReadable: lines,
    templateHash: onboardingTemplateHash(builder, req.network),
    expiresAt: req.nowMs + ASTER_BUNDLE_TTL_MS,
  };
}

/** Renewal bundle: one UpdateAgent step with a fresh 30-day expiry and the same fixed permissions. */
export function buildRenewal(req: Omit<AsterOnboardingRequest, "maxFeeRate">, ctx: Omit<AsterOnboardingCtx, "eligibilityStep" | "policyStep">): OnboardingBundle {
  const owner = assertAddress(req.owner, "owner");
  const agentAddress = assertAddress(req.agentAddress, "agentAddress");
  const ip = ipWhitelistFor(req.mode, ctx.relayEgressIp, req.directIp);
  const expired = req.nowMs + ASTER_AGENT_TTL_MS;
  const tx = updateAgentTx({ agentAddress, ipWhitelist: ip, expired, network: req.network, owner, nonce: nonceNumber(ctx.nonce, req.nowMs, ctx.serverTimeMs) });
  return {
    bundleId: ulid(req.nowMs),
    venue: "aster",
    owner,
    steps: [mgmtStep("aster_approve_agent", tx)],
    humanReadable: [`Renew agent ${agentAddress} until ${new Date(expired).toISOString()}. It still cannot trade spot or withdraw.`],
    templateHash: onboardingTemplateHash(assertAddress(ctx.builder, "builder"), req.network),
    expiresAt: req.nowMs + ASTER_BUNDLE_TTL_MS,
  };
}

// ---------------------------------------------------------------- submit
export interface StepResult {
  step: number;
  kind: OnboardingStep["kind"];
  path: string;
  status: "accepted" | "rejected" | "unknown";
  httpStatus: number;
  body: unknown;
}

function venueTxOf(step: OnboardingStep): AsterVenueTx | null {
  const tx = step.venueTx as AsterVenueTx | undefined;
  return tx && typeof tx.path === "string" && Array.isArray(tx.params) ? tx : null;
}

/**
 * Check every main-wallet signature against the bundle (recovers to the owner) before anything is sent, then send each
 * venue step in order: `{method} {path}?{params}&signature=..&signatureChainId=56`, empty form body. Never retried.
 */
export async function sendSignedSteps(bundle: OnboardingBundle, signed: SignedOnboarding, http: VenueHttp, nowMs: number): Promise<StepResult[]> {
  if (signed.bundleId !== bundle.bundleId) throw new CapstanError("PAYLOAD_MISMATCH", "signatures are for another bundle", { field: "bundleId" });
  if (nowMs > bundle.expiresAt) throw new CapstanError("BUILD_EXPIRED");
  const sigs = new Map(signed.signatures.map((s) => [s.step, s.sig]));
  const plan: { i: number; tx: AsterVenueTx; sig: Hex }[] = [];
  for (let i = 0; i < bundle.steps.length; i++) {
    const step = bundle.steps[i]!;
    const tx = venueTxOf(step);
    if (!tx) continue;
    const sig = sigs.get(i);
    if (!sig || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new CapstanError("INVALID_INPUT", `missing signature for step ${i}`, { field: `signatures.${i}` });
    // the typed data in the bundle must be exactly what the params produce
    const want = digestTypedData(mgmtTypedData(tx.primaryType, tx.params));
    if (!step.typedData || digestTypedData(step.typedData) !== want) throw new CapstanError("PAYLOAD_MISMATCH", `step ${i} typed data was changed`, { field: `steps.${i}` });
    const who = await recoverSigner(want, sig).catch(() => null);
    if (!who || who.toLowerCase() !== bundle.owner.toLowerCase()) throw new CapstanError("UNAUTHORIZED", `step ${i} is not signed by the owner`, { field: `signatures.${i}` });
    plan.push({ i, tx, sig });
  }
  const out: StepResult[] = [];
  for (const { i, tx, sig } of plan) {
    assertV3Path(tx.path);
    const qs = mgmtSentQuery(tx.params, sig);
    let status: StepResult["status"];
    let httpStatus = 0;
    let body: unknown = null;
    try {
      const raw = await http.request(tx.method, `${tx.path}?${qs}`, { form: {}, cost: 1 });
      httpStatus = raw.httpStatus;
      body = raw.body;
      status = httpStatus === 503 ? "unknown" : httpStatus >= 200 && httpStatus < 300 && !hasErrorCode(body) ? "accepted" : "rejected";
    } catch (e) {
      if (isUnknownOutcome(e)) status = "unknown";
      else if (e instanceof VenueHttpError) {
        status = "rejected";
        httpStatus = e.httpStatus;
        body = e.body;
      } else throw e;
    }
    out.push({ step: i, kind: bundle.steps[i]!.kind, path: tx.path, status, httpStatus, body });
  }
  return out;
}

function hasErrorCode(body: unknown): boolean {
  const c = (body as { code?: unknown } | null)?.code;
  return typeof c === "number" && c < 0;
}

export function agentRefFor(owner: Hex, agent: Hex): string {
  return `aster:${owner.toLowerCase()}:${agent.toLowerCase()}`;
}

/** Submit a signed onboarding bundle (relay side forwards; the main-wallet signatures were made on the user's device). */
export async function submitOnboarding(signed: SignedOnboarding, http: VenueHttp, bundle: OnboardingBundle, nowMs = Date.now()): Promise<OnboardingResult & { steps: StepResult[] }> {
  const results = await sendSignedSteps(bundle, signed, http, nowMs);
  const agentStep = bundle.steps.findIndex((s) => s.kind === "aster_approve_agent");
  const builderStep = bundle.steps.findIndex((s) => s.kind === "aster_approve_builder");
  const agentTx = agentStep >= 0 ? venueTxOf(bundle.steps[agentStep]!) : null;
  const agentAddress = (agentTx?.params.find(([k]) => k === "agentAddress")?.[1] ?? "") as Hex;
  const expired = agentTx?.params.find(([k]) => k === "expired")?.[1];
  const rate = builderStep >= 0 ? (venueTxOf(bundle.steps[builderStep]!)?.params.find(([k]) => k === "maxFeeRate")?.[1] as string | undefined) : undefined;
  const ok = (i: number) => results.find((r) => r.step === i)?.status === "accepted";
  const builderOk = builderStep >= 0 && ok(builderStep);
  return {
    agentRef: agentRefFor(bundle.owner, agentAddress),
    delegation: {
      agentActive: agentStep >= 0 && ok(agentStep),
      builderMaxBps: builderOk && rate ? Number(bps(rate)) : null,
      ...(typeof expired === "number" ? { expiresAt: new Date(expired).toISOString() } : {}),
      routing: builderOk ? "ok" : "fee_free_unavailable",
    },
    venueResponses: results.map((r) => ({ path: r.path, status: r.status, httpStatus: r.httpStatus, body: r.body })),
    steps: results,
  };
}
