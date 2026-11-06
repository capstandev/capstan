// Onboarding bundle checks (spec 7.2 step 4, threat model "phishing typed data"). Before ANY wallet prompt the SDK
// recomputes the template hash where the template is derivable from the bundle, requires it to be pinned for this
// release, and rebuilds every main-wallet step from the pinned values: builder address, approval ceiling, the new
// local key, the owner, the network, and permissions that can never include withdraw or transfer.
import type { AgentPolicy, Hex, OnboardingBundle, OnboardingStep, TypedDataPayload, VenueId } from "@capstan/schema";
import { mgmtTypedData, type AsterMgmtType, type ParamValue } from "@capstan/signer-aster";
import { userSignedTypedData, type HlUserAction } from "@capstan/signer-hl";
import { eqAddr, jcsString, keccakHex, utf8ToBytes } from "./bytes";
import type { LighterVenueId, Network, Pins } from "./pins";

export type BundleCheck = { ok: true; lines: string[] } | { ok: false; code: "TEMPLATE_UNKNOWN" | "PAYLOAD_MISMATCH" | "DEPLOYMENT_MISMATCH" | "BUILD_EXPIRED"; field: string };

export interface BundleCheckContext {
  venue: VenueId;
  network: Network;
  pins: Pins;
  owner: Hex;
  nowMs: number;
  /** The public part of the key this SDK just made for this onboarding. */
  agentAddress?: Hex;
  lighterPubKey?: string;
  policy?: AgentPolicy;
  /** Collateral moves the caller asked for (HL HIP-3 dexes). Any other move is refused. */
  collateralMoves?: { toDex: string; token: string; amount: string }[];
}

class Refusal {
  constructor(
    readonly code: Exclude<BundleCheck, { ok: true }>["code"],
    readonly field: string,
  ) {}
}
const no = (field: string, code: Exclude<BundleCheck, { ok: true }>["code"] = "PAYLOAD_MISMATCH"): never => {
  throw new Refusal(code, field);
};
const same = (a: unknown, b: unknown): boolean => {
  try {
    return jcsString(a) === jcsString(b);
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- template hashes (each venue's published formula)
export const HL_TEMPLATE_VERSION = 1;
const HL_PINNED_FIELDS = new Set(["maxFeeRate", "sourceDex", "fromSubAccount", "hyperliquidChain"]);

function tag(v: unknown): string {
  if (v === null) return "<null>";
  if (typeof v === "string") return /^0x[0-9a-fA-F]{40}$/.test(v) ? "<address>" : /^0x[0-9a-fA-F]*$/.test(v) ? "<hex>" : "<string>";
  if (typeof v === "number" || typeof v === "bigint") return "<number>";
  if (typeof v === "boolean") return "<bool>";
  if (Array.isArray(v)) return "<array>";
  return "<object>";
}

function typedShape(td: TypedDataPayload | undefined): unknown {
  if (!td) return null;
  const message: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(td.message)) message[k] = HL_PINNED_FIELDS.has(k) ? v : tag(v);
  return {
    primaryType: td.primaryType,
    types: td.types,
    domain: { name: td.domain.name ?? null, version: td.domain.version ?? null, chainId: tag(td.domain.chainId ?? null), verifyingContract: td.domain.verifyingContract ?? null },
    message,
  };
}

/** Hyperliquid: keccak256(JCS(shape)) where user values become type tags and the fixed fields stay literal. */
export function hlTemplateHash(b: Pick<OnboardingBundle, "venue" | "steps">): Hex {
  const shape = {
    v: HL_TEMPLATE_VERSION,
    venue: b.venue,
    steps: b.steps.map((s) => ({ kind: s.kind, signer: s.signer, typedData: typedShape(s.typedData), personalSignText: s.personalSignText === undefined ? null : "<string>", venueTx: s.venueTx === undefined ? null : "<object>" })),
  };
  return keccakHex(utf8ToBytes(jcsString(shape)));
}

export const LIGHTER_TEMPLATE_VERSION = "capstan-lighter-onboarding-v1";
/** Lighter: the venue, the signing id and the ordered step kinds. */
export function lighterTemplateHash(venue: LighterVenueId, signingChainId: number, kinds: string[]): Hex {
  return keccakHex(utf8ToBytes(JSON.stringify({ v: LIGHTER_TEMPLATE_VERSION, venue, signingChainId, kinds })));
}

export const ASTER_AGENT_NAME = "capstan";
export const ASTER_BUILDER_NAME = "capstan";
export const ASTER_AGENT_TTL_MS = 30 * 86_400_000;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

export function asterAgentParams(a: { agentAddress: Hex; ipWhitelist: string; expired: number; network: string; owner: Hex; nonce: number }): [string, ParamValue][] {
  return [
    ["agentName", ASTER_AGENT_NAME],
    ["agentAddress", a.agentAddress],
    ["ipWhitelist", a.ipWhitelist],
    ["expired", a.expired],
    ["canSpotTrade", false],
    ["canPerpTrade", true],
    ["canWithdraw", false],
    ["asterChain", a.network],
    ["user", a.owner],
    ["nonce", a.nonce],
  ];
}
export function asterBuilderParams(a: { builder: Hex; maxFeeRate: string; network: string; owner: Hex; nonce: number }): [string, ParamValue][] {
  return [
    ["builder", a.builder],
    ["maxFeeRate", a.maxFeeRate],
    ["builderName", ASTER_BUILDER_NAME],
    ["asterChain", a.network],
    ["user", a.owner],
    ["nonce", a.nonce],
  ];
}

/** Aster: the step shapes plus every fixed value (agent name, permissions, TTL, builder, ceiling). */
export function asterTemplateHash(builder: Hex, network: string, maxFeeRate: string): Hex {
  const fieldTypes = (t: AsterMgmtType, p: [string, ParamValue][]) => mgmtTypedData(t, p).types[t]!.map((f) => `${f.type} ${f.name}`);
  const template = [
    "capstan-aster-onboarding-v1",
    network,
    ["aster_approve_agent", "/fapi/v3/approveAgent", fieldTypes("ApproveAgent", asterAgentParams({ agentAddress: ZERO, ipWhitelist: "", expired: 0, network, owner: ZERO, nonce: 0 })), ASTER_AGENT_NAME, false, true, false, ASTER_AGENT_TTL_MS],
    ["aster_approve_builder", "/fapi/v3/approveBuilder", fieldTypes("ApproveBuilder", asterBuilderParams({ builder, maxFeeRate, network, owner: ZERO, nonce: 0 })), builder.toLowerCase(), maxFeeRate, ASTER_BUILDER_NAME],
  ];
  return keccakHex(utf8ToBytes(JSON.stringify(template)));
}

// ---------------------------------------------------------------- step checks
const TEN_MIN = 10 * 60_000;

function eligibilityStep(s: OnboardingStep, owner: Hex): void {
  if (s.signer !== "main_wallet" || !s.typedData) no("eligibility_declaration");
  const td = s.typedData!;
  if (td.domain.name !== "CapstanEligibility" || td.domain.version !== "1" || td.domain.verifyingContract !== undefined) no("eligibility_declaration.domain");
  const ownerField = td.message.owner;
  if (ownerField !== undefined && !eqAddr(ownerField, owner)) no("eligibility_declaration.owner");
  if (s.venueTx !== undefined || s.personalSignText !== undefined) no("eligibility_declaration");
}

function policyStep(s: OnboardingStep, owner: Hex, policy: AgentPolicy | undefined): void {
  if (s.signer !== "main_wallet" || !s.typedData) no("agent_policy");
  const td = s.typedData!;
  if (td.domain.name !== "CapstanAgentPolicy" || td.domain.version !== "1") no("agent_policy.domain");
  if (!eqAddr(td.message.owner, owner)) no("agent_policy.owner");
  if (!policy) no("agent_policy"); // a policy the caller did not ask for
  for (const k of ["maxNotionalPerOrderUsd", "maxGrossNotionalUsd", "maxLeverage", "maxOrdersPerDay", "nonce"] as const) if (String(td.message[k]) !== String(policy![k])) no(`agent_policy.${k}`);
}

function hlUserStep(s: OnboardingStep, kind: OnboardingStep["kind"], rebuild: (m: Record<string, unknown>, td: TypedDataPayload) => HlUserAction): void {
  if (s.kind !== kind || s.signer !== "main_wallet" || !s.typedData) no(kind);
  if (s.typedData!.domain.name !== "HyperliquidSignTransaction") no(`${kind}.domain`);
  const m = s.typedData!.message;
  const action = rebuild(m, s.typedData!);
  let want: TypedDataPayload;
  try {
    want = userSignedTypedData(action);
  } catch {
    return no(kind);
  }
  if (!same(want, s.typedData)) no(`${kind}.typedData`);
  const tx = s.venueTx as { action?: { type?: string } } | undefined;
  if (!tx || tx.action?.type !== action.type) no(`${kind}.venueTx`);
}

function checkHlBundle(b: OnboardingBundle, ctx: BundleCheckContext): void {
  const p = ctx.pins.networks[ctx.network];
  const builder = p.builders.hyperliquid;
  if (!builder) no("builder", "DEPLOYMENT_MISMATCH");
  if (!ctx.agentAddress) no("agentAddress");
  if (hlTemplateHash(b).toLowerCase() !== b.templateHash.toLowerCase()) no("templateHash", "TEMPLATE_UNKNOWN");
  const steps = b.steps;
  let i = 0;
  if (steps[i]?.kind !== "eligibility_declaration") no("steps");
  eligibilityStep(steps[i++]!, ctx.owner);
  const chain = p.hlNetwork;
  const sigChain = (m: Record<string, unknown>, td: TypedDataPayload) => {
    const cid = Number(td.domain.chainId);
    if (!Number.isSafeInteger(cid) || cid <= 0) no("signatureChainId");
    if (m.hyperliquidChain !== chain) no("hyperliquidChain");
    if (!Number.isSafeInteger(m.nonce) || Math.abs((m.nonce as number) - ctx.nowMs) > TEN_MIN) no("nonce");
    return { hyperliquidChain: chain, signatureChainId: `0x${cid.toString(16)}` as Hex, nonce: m.nonce as number };
  };
  hlUserStep(steps[i++]!, "hl_approve_agent", (m, td) => {
    if (!eqAddr(m.agentAddress, ctx.agentAddress)) no("hl_approve_agent.agentAddress");
    if (typeof m.agentName !== "string" || !/^cpst-[0-9a-z]{6}( valid_until \d+)?$/.test(m.agentName)) no("hl_approve_agent.agentName");
    return { type: "approveAgent", ...sigChain(m, td), agentAddress: ctx.agentAddress!.toLowerCase() as Hex, agentName: m.agentName as string };
  });
  hlUserStep(steps[i++]!, "hl_approve_builder_fee", (m, td) => {
    if (!eqAddr(m.builder, builder)) no("hl_approve_builder_fee.builder");
    if (m.maxFeeRate !== p.approvalCeilings.hyperliquid) no("hl_approve_builder_fee.maxFeeRate");
    return { type: "approveBuilderFee", ...sigChain(m, td), maxFeeRate: p.approvalCeilings.hyperliquid, builder: builder! };
  });
  const moves = [...(ctx.collateralMoves ?? [])];
  while (steps[i]?.kind === "hl_collateral_move") {
    const want = moves.shift();
    if (!want) no("hl_collateral_move");
    hlUserStep(steps[i++]!, "hl_collateral_move", (m, td) => {
      if (!eqAddr(m.destination, ctx.owner)) no("hl_collateral_move.destination");
      if (m.sourceDex !== "" || m.fromSubAccount !== "") no("hl_collateral_move.source");
      if (m.destinationDex !== want!.toDex || m.token !== want!.token || m.amount !== want!.amount) no("hl_collateral_move.amount");
      return { type: "sendAsset", ...sigChain(m, td), destination: ctx.owner.toLowerCase() as Hex, sourceDex: "", destinationDex: want!.toDex, token: want!.token, amount: want!.amount, fromSubAccount: "" };
    });
  }
  if (moves.length) no("hl_collateral_move");
  if (steps[i]?.kind === "agent_policy") policyStep(steps[i++]!, ctx.owner, ctx.policy);
  else if (ctx.policy) no("agent_policy");
  if (i !== steps.length) no("steps");
}

function asterMgmt(s: OnboardingStep, kind: OnboardingStep["kind"], primaryType: AsterMgmtType, path: string, rebuild: (params: Map<string, ParamValue>) => [string, ParamValue][]): void {
  if (s.kind !== kind || s.signer !== "main_wallet" || !s.typedData) no(kind);
  const tx = s.venueTx as { method?: string; path?: string; primaryType?: string; params?: [string, ParamValue][] } | undefined;
  if (!tx || tx.method !== "POST" || tx.path !== path || tx.primaryType !== primaryType || !Array.isArray(tx.params)) no(`${kind}.venueTx`);
  const want = rebuild(new Map(tx!.params!.map(([k, v]) => [k, v])));
  if (!same(want, tx!.params)) no(`${kind}.params`);
  if (!same(mgmtTypedData(primaryType, want), s.typedData)) no(`${kind}.typedData`);
}

function checkAsterBundle(b: OnboardingBundle, ctx: BundleCheckContext): void {
  const p = ctx.pins.networks[ctx.network];
  const builder = p.builders.aster;
  if (!builder) no("builder", "DEPLOYMENT_MISMATCH");
  if (!ctx.agentAddress) no("agentAddress");
  const net = p.asterNetwork;
  if (asterTemplateHash(builder!, net, p.approvalCeilings.aster).toLowerCase() !== b.templateHash.toLowerCase()) no("templateHash", "TEMPLATE_UNKNOWN");
  const steps = b.steps;
  let i = 0;
  if (steps[i]?.kind !== "eligibility_declaration") no("steps");
  eligibilityStep(steps[i++]!, ctx.owner);
  const nonceOf = (m: Map<string, ParamValue>) => {
    const n = m.get("nonce");
    if (typeof n !== "number" || !Number.isSafeInteger(n) || Math.abs(n / 1000 - ctx.nowMs) > 60_000) no("nonce");
    return n as number;
  };
  asterMgmt(steps[i++]!, "aster_approve_agent", "ApproveAgent", "/fapi/v3/approveAgent", (m) => {
    const ip = m.get("ipWhitelist");
    if (typeof ip !== "string" || /[,\s;|/]/.test(ip)) no("aster_approve_agent.ipWhitelist");
    const exp = m.get("expired");
    if (typeof exp !== "number" || exp <= ctx.nowMs || exp - ctx.nowMs > ASTER_AGENT_TTL_MS + TEN_MIN) no("aster_approve_agent.expired");
    if (m.get("canWithdraw") !== false) no("aster_approve_agent.canWithdraw");
    if (m.get("canSpotTrade") !== false) no("aster_approve_agent.canSpotTrade");
    if (!eqAddr(m.get("agentAddress"), ctx.agentAddress)) no("aster_approve_agent.agentAddress");
    if (!eqAddr(m.get("user"), ctx.owner)) no("aster_approve_agent.user");
    return asterAgentParams({ agentAddress: m.get("agentAddress") as Hex, ipWhitelist: ip as string, expired: exp as number, network: net, owner: m.get("user") as Hex, nonce: nonceOf(m) });
  });
  asterMgmt(steps[i++]!, "aster_approve_builder", "ApproveBuilder", "/fapi/v3/approveBuilder", (m) => {
    if (!eqAddr(m.get("builder"), builder)) no("aster_approve_builder.builder");
    if (m.get("maxFeeRate") !== p.approvalCeilings.aster) no("aster_approve_builder.maxFeeRate");
    if (!eqAddr(m.get("user"), ctx.owner)) no("aster_approve_builder.user");
    return asterBuilderParams({ builder: m.get("builder") as Hex, maxFeeRate: p.approvalCeilings.aster, network: net, owner: m.get("user") as Hex, nonce: nonceOf(m) });
  });
  if (steps[i]?.kind === "agent_policy") policyStep(steps[i++]!, ctx.owner, ctx.policy);
  else if (ctx.policy) no("agent_policy");
  if (i !== steps.length) no("steps");
}

const hex16 = (n: number) => `0x${n.toString(16).padStart(16, "0")}`;
/** lighter-go ChangePubKey text, byte for byte (the main wallet signs exactly this). */
export function changePubKeyMessage(pubKeyHex: string, nonce: number, accountIndex: number, apiKeyIndex: number): string {
  const pk = pubKeyHex.replace(/^0x/i, "").toLowerCase();
  return `Register Lighter Account\n\npubkey: 0x${pk}\nnonce: ${hex16(nonce)}\naccount index: ${hex16(accountIndex)}\napi key index: ${hex16(apiKeyIndex)}\nOnly sign this message for a trusted client!`;
}
export const isUsableLighterKeyIndex = (i: number): boolean => Number.isInteger(i) && ((i >= 4 && i <= 156) || (i >= 158 && i <= 254));

function checkLighterBundle(b: OnboardingBundle, ctx: BundleCheckContext): void {
  const venue = ctx.venue as LighterVenueId;
  const p = ctx.pins.networks[ctx.network];
  const sid = p.lighterSigningIds[venue];
  if (lighterTemplateHash(venue, sid, b.steps.map((s) => s.kind)).toLowerCase() !== b.templateHash.toLowerCase()) no("templateHash", "TEMPLATE_UNKNOWN");
  if (!ctx.lighterPubKey) no("lighterPubKey");
  const pub = `0x${ctx.lighterPubKey!.replace(/^0x/i, "").toLowerCase()}`;
  const steps = b.steps;
  let i = 0;
  if (steps[i]?.kind === "eligibility_declaration") eligibilityStep(steps[i++]!, ctx.owner);
  const cpk = steps[i++];
  if (!cpk || cpk.kind !== "lighter_change_pubkey" || cpk.signer !== "main_wallet") no("lighter_change_pubkey");
  const tx = cpk!.venueTx as { txType?: number; args?: { pubKeyHex: string; nonce: number; apiKeyIndex: number; accountIndex: number; expiredAt: number }; signWith?: string };
  if (!tx || tx.txType !== 8 || tx.signWith !== "new_api_key" || !tx.args) no("lighter_change_pubkey.venueTx");
  const a = tx.args!;
  if (String(a.pubKeyHex).toLowerCase() !== pub) no("lighter_change_pubkey.pubKey");
  if (!isUsableLighterKeyIndex(a.apiKeyIndex)) no("lighter_change_pubkey.apiKeyIndex");
  if (!Number.isSafeInteger(a.accountIndex) || a.accountIndex < 0) no("lighter_change_pubkey.accountIndex");
  if (!Number.isSafeInteger(a.nonce) || a.nonce < 0) no("lighter_change_pubkey.nonce");
  if (!Number.isSafeInteger(a.expiredAt) || a.expiredAt <= ctx.nowMs || a.expiredAt - ctx.nowMs > TEN_MIN + 30_000) no("lighter_change_pubkey.expiredAt");
  if (cpk!.personalSignText !== changePubKeyMessage(pub, a.nonce, a.accountIndex, a.apiKeyIndex)) no("lighter_change_pubkey.text");
  if (steps[i]?.kind === "lighter_approve_integrator") {
    const s = steps[i++]!;
    const integ = p.lighterIntegratorIndex[venue];
    const t = s.venueTx as { txType?: number; args?: Record<string, number>; signWith?: string };
    if (s.signer !== "delegated_key" || !t || t.txType !== 45 || t.signWith !== "new_api_key" || !t.args) no("lighter_approve_integrator");
    if (integ === null || t.args!.integratorAccountIndex !== integ) no("lighter_approve_integrator.integratorAccountIndex", "DEPLOYMENT_MISMATCH");
    for (const k of ["maxPerpsTakerFee", "maxPerpsMakerFee", "maxSpotTakerFee", "maxSpotMakerFee"]) if (t.args![k] !== 0) no(`lighter_approve_integrator.${k}`);
    if (t.args!.accountIndex !== a.accountIndex || t.args!.apiKeyIndex !== a.apiKeyIndex) no("lighter_approve_integrator.account");
  }
  if (steps[i]?.kind === "agent_policy") policyStep(steps[i++]!, ctx.owner, ctx.policy);
  else if (ctx.policy) no("agent_policy");
  if (i !== steps.length) no("steps");
}

/** SDK-authored plain sentences shown before the wallet prompts (never only the server's text). */
export function describeBundle(b: OnboardingBundle, ctx: BundleCheckContext): string[] {
  const p = ctx.pins.networks[ctx.network];
  const lines: string[] = [];
  for (const s of b.steps) {
    switch (s.kind) {
      case "eligibility_declaration":
        lines.push("Sign the eligibility declaration: you confirm you may use this venue from where you are.");
        break;
      case "hl_approve_agent":
        lines.push(`Let the new trading key ${ctx.agentAddress} trade on Hyperliquid for ${ctx.owner}. It cannot withdraw or transfer.`);
        break;
      case "hl_approve_builder_fee":
        lines.push(`Approve a builder fee of at most ${p.approvalCeilings.hyperliquid} (3 bps) per trade, paid to builder ${p.builders.hyperliquid}. You can revoke it from your wallet.`);
        break;
      case "hl_collateral_move": {
        const m = s.typedData?.message ?? {};
        lines.push(`Move ${String(m.amount)} ${String(m.token).split(":")[0]} inside your own Hyperliquid account to the ${String(m.destinationDex)} dex. It stays yours.`);
        break;
      }
      case "aster_approve_agent":
        lines.push(`Let the new trading key ${ctx.agentAddress} trade Aster perpetuals for ${ctx.owner} for up to 30 days. It cannot trade spot and cannot withdraw.`);
        break;
      case "aster_approve_builder":
        lines.push(`Approve a builder fee of at most ${p.approvalCeilings.aster} (3 bps) per order, paid to builder ${p.builders.aster}.`);
        break;
      case "lighter_change_pubkey":
        lines.push(`Register the new trading key on ${ctx.venue === "lighter-rh" ? "Lighter on Robinhood Chain" : "Lighter"}. It can trade and cancel; it cannot send funds to another address. No fee is charged.`);
        break;
      case "lighter_approve_integrator":
        lines.push("Tag your Lighter orders with Capstan at 0 fees (the trading key signs this, not your wallet).");
        break;
      case "agent_policy":
        lines.push(`Sign the agent policy: at most ${ctx.policy?.maxNotionalPerOrderUsd} USD per order and ${ctx.policy?.maxOrdersPerDay} orders a day.`);
        break;
      default:
        lines.push(`Step ${s.kind}.`);
    }
  }
  return lines;
}

/** Every check, before any wallet prompt. */
export function checkOnboardingBundle(b: OnboardingBundle, ctx: BundleCheckContext): BundleCheck {
  try {
    if (!b || typeof b !== "object" || !Array.isArray(b.steps)) no("bundle");
    if (b.venue !== ctx.venue) no("venue");
    if (!eqAddr(b.owner, ctx.owner)) no("owner");
    if (typeof b.expiresAt !== "number" || ctx.nowMs > b.expiresAt) no("expiresAt", "BUILD_EXPIRED");
    if (typeof b.templateHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.templateHash)) no("templateHash", "TEMPLATE_UNKNOWN");
    const pinned = ctx.pins.networks[ctx.network].templateHashes[ctx.venue as keyof Pins["networks"]["mainnet"]["templateHashes"]] ?? [];
    if (!pinned.some((h) => h.toLowerCase() === b.templateHash.toLowerCase())) no("templateHash", "TEMPLATE_UNKNOWN");
    if (!Array.isArray(b.humanReadable) || b.humanReadable.length !== b.steps.length || b.humanReadable.some((l) => typeof l !== "string" || l.trim() === "")) no("humanReadable");
    for (const s of b.steps) {
      if (s.kind === "revoke_agent" || s.kind === "revoke_builder") no("steps"); // never in an onboarding bundle
      const body = JSON.stringify([s.typedData ?? null, s.venueTx ?? null]).toLowerCase();
      if (/withdraw"\s*[:,]\s*true|"cantransfer"\s*[:,]\s*true|"type"\s*:\s*"(withdraw\d*|usdsend|spotsend|vaulttransfer|usdclasstransfer|subaccounttransfer)"/.test(body)) no(`${s.kind}.permissions`);
    }
    if (ctx.venue === "hyperliquid") checkHlBundle(b, ctx);
    else if (ctx.venue === "aster") checkAsterBundle(b, ctx);
    else if (ctx.venue === "lighter-mainnet" || ctx.venue === "lighter-rh") checkLighterBundle(b, ctx);
    else no("venue");
    return { ok: true, lines: describeBundle(b, ctx) };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, code: e.code, field: e.field };
    return { ok: false, code: "PAYLOAD_MISMATCH", field: "bundle" };
  }
}
