// Relay pipeline (spec 7.3 step 5, 9, 14). Every step refuses with its own code and every refusal gets a signed
// `refusal` receipt. The relay forwards the client's signed body unchanged, only after verifySigned matched it to the
// stored build, and at most once per payload (orders.signed_payload_hash is unique). Logs carry payload hashes only.
//  1 load the build; BUILD_EXPIRED after 30 s          6 dedupe: INSERT orders -> DUPLICATE_PAYLOAD
//  2 delegation and kill state                          7 lane: free (per wallet and IP /64) or pro; bot cap
//  3 adapter.verifySigned -> PAYLOAD_MISMATCH           8 governor.acquire(venue, cost, priority), adapter.submit once
//  4 policy re-check -> POLICY_BREACH (alert queued)    9 order.submit / order.cancel receipt; venue errors too
//  5 eligibility re-check with the submit IP
import { defaultIsEquity, type EligibilityDecision } from "@capstan/eligibility";
import { checkPolicy } from "@capstan/policy";
import { draft } from "@capstan/receipts";
import { CapstanError, type ErrorCode, type Hex, type Order, type SignedEnvelope, type SubmitResult } from "@capstan/schema";
import { acquireLighterSubmit, type Priority } from "@capstan/venue-client";
import { ipBucket } from "./ip";
import { DIRECT_MODE_HINT } from "./lanes";
import type { RelayDeps, RelayVenue, StoredBuild, SubmitOutcome } from "./types";
import { sha256Jcs, venueErrorText } from "./venues";

export const RELAY_PAUSED = "relay paused" as const;
export const BUILDER_HINT = "Approve the Capstan builder fee in onboarding (POST /v1/onboarding/build), then build the order again.";
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** What a direct-mode claim needs (the api serves claims in-process, without the submit lanes or the governor). */
export type ClaimDeps = Pick<RelayDeps, "store" | "venues" | "receipts" | "policy" | "flags" | "kill" | "now" | "id" | "log">;

export interface SubmitRequest {
  buildId: string;
  signedEnvelope: SignedEnvelope;
}
export interface SubmitContext {
  ip: string;
  apiKey?: string; // API key account id (never the key itself)
}

interface RefuseOpts {
  b: StoredBuild | null;
  buildId: string;
  payloadHash?: string | null;
  decisionId?: string;
  message?: string;
  field?: string;
}

/** Issue the refusal receipt, then throw the refusal. If the receipt cannot be issued the request is still refused. */
async function refuse(deps: Pick<RelayDeps, "receipts" | "log">, code: ErrorCode, o: RefuseOpts): Promise<never> {
  const ph = typeof o.payloadHash === "string" && HEX32.test(o.payloadHash) ? (o.payloadHash.toLowerCase() as Hex) : null;
  let receiptId: string | undefined;
  try {
    const r = await deps.receipts.issue(
      draft("refusal", {
        requestHash: sha256Jcs({ relay: "submit", code, buildId: o.buildId, payloadHash: ph, field: o.field ?? null }),
        eligibilityDecisionId: o.decisionId ?? o.b?.eligibilityDecisionId ?? `relay:${code}`,
        owner: o.b ? (o.b.owner.toLowerCase() as Hex) : null,
        agentRef: o.b?.agentRef ?? null,
        venue: o.b?.venue ?? null,
        marketId: o.b?.marketId ?? null,
        buildId: o.b ? o.b.build.buildId : null,
        signedPayloadHash: ph,
        policyId: o.b?.policyId ?? null,
      }),
    );
    receiptId = r.receiptId;
  } catch (e) {
    deps.log?.("refusal receipt failed", { code, buildId: o.buildId, error: (e as Error).message });
  }
  deps.log?.("refused", { code, buildId: o.buildId, payloadHash: ph, field: o.field ?? null });
  throw new CapstanError(code, o.message, { ...(receiptId ? { receiptId } : {}), ...(o.field ? { field: o.field } : {}) });
}

function orderOf(b: StoredBuild, r: SubmitResult, nowMs: number): Order {
  const p = b.build.preview;
  const status: Order["status"] = r.status === "rejected" ? "rejected" : b.kind === "cancel" && r.status === "accepted" ? "cancelled" : "open";
  return {
    venue: b.venue,
    marketId: b.marketId,
    venueOrderId: r.venueOrderId ?? "",
    side: p.side,
    size: p.size,
    filled: "0",
    px: p.px,
    status,
    builderFeeBps: p.builderFeeBps,
    createdAt: new Date(nowMs).toISOString(),
  };
}

const verifyCode = (c: string): ErrorCode => (c === "BAD_SIGNATURE" ? "PAYLOAD_MISMATCH" : (c as ErrorCode));

/** Steps 1 to 3, shared by relay submits and direct-mode claims. */
async function loadAndVerify(req: SubmitRequest, deps: ClaimDeps, o: { checkAgent: boolean }): Promise<{ b: StoredBuild; venue: RelayVenue; payloadHash: Hex; policy: Awaited<ReturnType<RelayDeps["policy"]["active"]>> }> {
  const env = req.signedEnvelope;
  const now = deps.now();
  const b = await deps.store.getBuild(req.buildId);
  const ref: RefuseOpts = { b, buildId: req.buildId, payloadHash: env?.payloadHash ?? null };
  if (!b) return refuse(deps, "NOT_FOUND", { ...ref, message: "Unknown build." });
  const venue = deps.venues.get(b.venue);
  if (!venue) return refuse(deps, "UNSUPPORTED_VENUE", ref);
  if (o.checkAgent && (!deps.flags.relayEnabled() || !deps.flags.venueEnabled(venue.flag))) {
    deps.log?.("relay paused refusal", { venue: b.venue, buildId: b.build.buildId });
    return refuse(deps, "VENUE_ERROR", { ...ref, message: RELAY_PAUSED });
  }
  if (o.checkAgent && now > b.expiresAt) return refuse(deps, "BUILD_EXPIRED", ref);
  if (!env || env.buildId !== req.buildId || env.buildId !== b.build.buildId) return refuse(deps, "PAYLOAD_MISMATCH", { ...ref, field: "buildId" });
  if (env.venue !== b.venue) return refuse(deps, "PAYLOAD_MISMATCH", { ...ref, field: "venue" });

  // 2: delegation state and the kill switch
  let policy: Awaited<ReturnType<RelayDeps["policy"]["active"]>> = null;
  if (b.agentRef) {
    policy = await deps.policy.active(b.agentRef, b.owner);
    if (o.checkAgent) {
      const d = await deps.store.getDelegation(b.agentRef);
      if (!d || d.owner.toLowerCase() !== b.owner.toLowerCase() || d.state === "retired") return refuse(deps, "RETIRED_AGENT", ref);
      if (d.state === "killed") return refuse(deps, "AGENT_KILLED", ref);
      if (d.expiresAt !== null && now >= d.expiresAt) return refuse(deps, "RETIRED_AGENT", { ...ref, message: "This agent's venue authorization has expired. Onboard a new one." });
      const k = await deps.kill.status(b.agentRef);
      if (k === "killed") return refuse(deps, "AGENT_KILLED", ref);
      if (k === "unknown" && policy) return refuse(deps, "AGENT_KILLED", { ...ref, message: "The kill switch cannot be read; agents under a policy are refused until it can." });
    }
  }

  // 3: the signed body must be exactly what the build produced
  let payloadHash: Hex;
  try {
    payloadHash = venue.payloadHashOf(env, b);
  } catch {
    return refuse(deps, "PAYLOAD_MISMATCH", { ...ref, field: "signedBody" });
  }
  ref.payloadHash = payloadHash;
  if (typeof env.payloadHash !== "string" || env.payloadHash.toLowerCase() !== payloadHash.toLowerCase()) return refuse(deps, "PAYLOAD_MISMATCH", { ...ref, field: "payloadHash" });
  let v;
  try {
    // a claim arrives after the venue answered: the 30 s window bounds relay submits only, so a claim is checked
    // against the same build with the window lifted (every field, hash and signature check still runs)
    v = venue.adapter.verifySigned(env, o.checkAgent ? b.build : { ...b.build, expiresAt: Number.MAX_SAFE_INTEGER });
  } catch {
    return refuse(deps, "PAYLOAD_MISMATCH", { ...ref, field: "signedBody" });
  }
  if (!v.ok) return refuse(deps, verifyCode(v.code), { ...ref, ...(v.field ? { field: v.field } : {}) });
  return { b, venue, payloadHash, policy };
}

export async function handleSubmit(req: SubmitRequest, ctx: SubmitContext, deps: RelayDeps): Promise<SubmitOutcome> {
  const env = req.signedEnvelope;
  const { b, venue, payloadHash, policy } = await loadAndVerify(req, deps, { checkAgent: true });
  const ref: RefuseOpts = { b, buildId: req.buildId, payloadHash };
  const now = deps.now();

  // 4: policy re-check (cancels always pass: they only remove risk)
  if (policy && b.agentRef && b.kind !== "cancel") {
    const usage = await deps.store.agentUsage(b.agentRef, now);
    const p = b.build.preview;
    const r = checkPolicy({ policy: policy.policy, agentRef: b.agentRef, venue: b.venue, marketId: b.marketId, side: p.side, notionalUsd: p.notionalUsd, leverage: b.leverage, reduceOnly: p.reduceOnly, grossNotionalUsd: usage.grossNotionalUsd, ordersToday: usage.ordersToday, nowMs: now, mode: "relay" });
    if (!r.ok) {
      try {
        await deps.alerts.policyBreach({ owner: b.owner, agentRef: b.agentRef, field: r.field, buildId: b.build.buildId });
      } catch (e) {
        deps.log?.("breach alert enqueue failed", { error: (e as Error).message });
      }
      return refuse(deps, "POLICY_BREACH", { ...ref, field: r.field, message: `The request breaches the agent policy (${r.field}).` });
    }
  }

  // 5: eligibility with the submit IP (cancels and reduce-only closes always pass: a refused region can still exit)
  let decision: EligibilityDecision | null = null;
  if (b.kind === "order" && !b.build.preview.reduceOnly) {
    if (await deps.venueSignals.get(b.owner, b.venue, now)) return refuse(deps, "GEO_REFUSED", ref);
    decision = await deps.eligibility({ ip: ctx.ip, owner: b.owner, ...(b.agentRef ? { agentRef: b.agentRef } : {}), venue: b.venue, marketId: b.marketId, isEquityMarket: defaultIsEquity(b.marketId), action: "order" });
    if (!decision.allowed) return refuse(deps, (decision.code ?? "GEO_REFUSED") as ErrorCode, { ...ref, decisionId: decision.id });
  }

  // 6: dedupe on the recomputed payload hash
  const orderId = deps.id();
  const inserted = await deps.store.insertOrder({ id: orderId, buildId: b.build.buildId, venue: b.venue, marketId: b.marketId, owner: b.owner.toLowerCase() as Hex, signedPayloadHash: payloadHash, mode: "relay", status: "pending", builderFeeBps: b.build.preview.builderFeeBps, submittedAt: new Date(now) });
  if (!inserted) return refuse(deps, "DUPLICATE_PAYLOAD", ref);

  // 7: lanes
  const { lane, perMin } = await deps.laneOf(b.owner, ctx.apiKey);
  const taken = await deps.lanes.take({ wallet: b.owner, ipBucket: ipBucket(ctx.ip), lane, perMin, kind: b.kind, nowMs: now });
  if (!taken.ok) {
    await deps.store.releaseOrder(orderId);
    return refuse(deps, "VENUE_RATE_LIMITED", { ...ref, message: DIRECT_MODE_HINT, field: taken.reason ?? "lane" });
  }

  // 8: governed submit, exactly once
  const priority: Priority = b.kind === "order" ? lane : "safety";
  const deadlineMs = priority === "safety" ? undefined : priority === "pro" ? (deps.proBudgetWaitMs ?? 10_000) : (deps.freeBudgetWaitMs ?? 2_000);
  let result: SubmitResult;
  try {
    result = await deps.dispatch.run(priority, async () => {
      const opts = { priority, ...(deadlineMs !== undefined ? { deadlineMs } : {}) };
      if (venue.lighterL1) await acquireLighterSubmit(deps.governor, venue.governorKey as "lighter-304" | "lighter-466324" | "lighter-300", venue.lighterL1(b), opts);
      else await deps.governor.acquire(venue.governorKey, venue.costOf(env), opts);
      try {
        return await venue.adapter.submit(env);
      } catch (e) {
        // the request may or may not have left: never resent, recorded as unknown
        return { status: "unknown", venueOrderId: null, txHash: null, venueResponse: String((e as Error).message ?? e).slice(0, 200), code: "VENUE_ERROR", message: "no clear answer from the venue" } satisfies SubmitResult;
      }
    });
  } catch (e) {
    await deps.store.releaseOrder(orderId);
    if (e instanceof CapstanError && e.code === "VENUE_RATE_LIMITED") return refuse(deps, "VENUE_RATE_LIMITED", { ...ref, message: `${DIRECT_MODE_HINT} (${e.message})`, field: "venue_budget" });
    throw e;
  }

  // 9: receipts
  if (result.status !== "accepted" && venue.isGeoError?.(result)) {
    await deps.venueSignals.put(b.owner, b.venue, now);
    await deps.store.updateOrder(orderId, { status: "refused" });
    return refuse(deps, "GEO_REFUSED", { ...ref, decisionId: decision?.id ?? b.eligibilityDecisionId, field: "venue_signal" });
  }
  const receipt = await deps.receipts.issue(venue.draft(b, env, result, payloadHash));
  await deps.store.updateOrder(orderId, { status: result.status, venueOrderId: result.venueOrderId });
  deps.log?.("submitted", { venue: b.venue, buildId: b.build.buildId, payloadHash, status: result.status, receiptId: receipt.receiptId });
  if (result.status === "rejected") {
    if (result.code === "BUILDER_APPROVAL_REQUIRED") throw new CapstanError("BUILDER_APPROVAL_REQUIRED", `${ERROR_BUILDER} ${BUILDER_HINT}`, { receiptId: receipt.receiptId });
    throw new CapstanError("VENUE_ERROR", `The venue refused the order: ${venueErrorText(result)}`, { receiptId: receipt.receiptId });
  }
  return { order: orderOf(b, result, now), receiptId: receipt.receiptId, outcome: result.status };
}

const ERROR_BUILDER = "The venue refused the builder fee field.";

export interface ClaimRequest extends SubmitRequest {
  venueResponse: unknown;
}

/** Direct mode: the SDK posted to the venue itself. The envelope must hash-match the build and pass verifySigned; one claim receipt per build. */
export async function handleClaim(req: ClaimRequest, deps: ClaimDeps): Promise<{ receiptId: string }> {
  const env = req.signedEnvelope;
  const { b, venue, payloadHash } = await loadAndVerify(req, deps, { checkAgent: false });
  const now = deps.now();
  await deps.store.insertOrder({ id: deps.id(), buildId: b.build.buildId, venue: b.venue, marketId: b.marketId, owner: b.owner.toLowerCase() as Hex, signedPayloadHash: payloadHash, mode: "direct", status: "claimed", builderFeeBps: b.build.preview.builderFeeBps, submittedAt: new Date(now) });
  const resp = req.venueResponse ?? null;
  const r = resp as { orderId?: unknown; tx_hash?: unknown } | null;
  const result: SubmitResult = { status: "accepted", venueOrderId: r && (typeof r.orderId === "string" || typeof r.orderId === "number") ? String(r.orderId) : null, txHash: r && typeof r.tx_hash === "string" ? r.tx_hash : null, venueResponse: resp };
  const d = venue.draft(b, env, result, payloadHash);
  // one claim per build: the request hash names the build only, so a second claim returns the first receipt
  const { action: _a, ...rest } = d;
  const receipt = await deps.receipts.issue(draft("order.claim", { ...rest, requestHash: sha256Jcs({ relay: "claim", buildId: b.build.buildId }) }));
  deps.log?.("claimed", { venue: b.venue, buildId: b.build.buildId, payloadHash, receiptId: receipt.receiptId });
  return { receiptId: receipt.receiptId };
}
