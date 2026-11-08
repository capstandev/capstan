// Relay pipeline (spec 7.3 step 5, 9, 14). Every step refuses with its own code and every refusal gets a signed
// `refusal` receipt. The relay forwards the client's signed body unchanged, only after verifySigned matched it to the
// stored build, and at most once per payload (orders.signed_payload_hash is unique). Logs carry payload hashes only.
//  1 load the build; BUILD_EXPIRED after 30 s          6 dedupe: INSERT orders -> DUPLICATE_PAYLOAD
//  2 delegation and kill state                          7 lane: free (per wallet and IP /64) or pro; bot cap
//  3 adapter.verifySigned -> PAYLOAD_MISMATCH           8 governor.acquire(venue, cost, priority), adapter.submit once
//  4 policy re-check -> POLICY_BREACH (alert queued)    9 order.submit / order.cancel receipt; venue errors too
//  5 eligibility re-check with the submit IP
import { recordFunnel, recordGovernorUse, SERVICE_METRICS } from "@capstan/telemetry";
import { defaultIsEquity, type EligibilityDecision } from "@capstan/eligibility";
import { checkPolicy } from "@capstan/policy";
import { draft } from "@capstan/receipts";
import { CapstanError, type ErrorCode, type Hex, type Order, type SignedEnvelope, type SubmitResult, type VenueId } from "@capstan/schema";
import { acquireLighterSubmit, type Priority } from "@capstan/venue-client";
import { ipBucket } from "./ip";
import { DIRECT_MODE_HINT } from "./lanes";
import type { AgentUsage, ExposureSource, RelayDeps, RelayVenue, ReserveCheck, StoredBuild, SubmitOutcome } from "./types";
import { sha256Jcs, venueErrorText } from "./venues";

export const RELAY_PAUSED = "relay paused" as const;
export const RELAY_NOT_ARMED = "relay submitting is not armed on this host; sign and send in direct mode" as const;
export const BUILDER_HINT = "Approve the Capstan builder fee in onboarding (POST /v1/onboarding/build), then build the order again.";
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
/** Opening orders this long before a positions read still count on top of it (a fill may not be in the read yet). */
export const EXPOSURE_SLACK_MS = 60_000;

/** What a direct-mode claim needs (the api serves claims in-process, without the submit lanes or the governor). */
export type ClaimDeps = Pick<RelayDeps, "store" | "venues" | "receipts" | "policy" | "flags" | "kill" | "now" | "id" | "log">;

export interface SubmitRequest {
  buildId: string;
  signedEnvelope: SignedEnvelope;
}
export interface SubmitContext {
  ip: string;
  apiKey?: string; // API key account id (never the key itself)
  /**
   * A stalled relay job that BullMQ runs again (security r1 R1-07): when the first run already holds this payload's
   * order row, the answer is what that run recorded, never DUPLICATE_PAYLOAD and never a second send.
   */
  rerun?: boolean;
}

/** What a re-run of a stalled job answers for a payload the first run already recorded (it is never sent again). */
async function replayOf(deps: RelayDeps, b: StoredBuild, payloadHash: string, now: number): Promise<SubmitOutcome | null> {
  const prior = await deps.store.orderByHash(payloadHash).catch(() => null);
  if (!prior || prior.buildId !== b.build.buildId) return null;
  // "pending": the first run stopped between the row and the venue answer, so the order may have been sent
  const status: SubmitResult["status"] = prior.status === "accepted" || prior.status === "rejected" ? prior.status : "unknown";
  const result: SubmitResult = { status, venueOrderId: prior.venueOrderId, txHash: null, venueResponse: null };
  deps.log?.("relay job re-run: answering with the first run's record", { buildId: b.build.buildId, payloadHash, status: prior.status });
  if (status === "rejected") throw new CapstanError("VENUE_ERROR", "The venue refused the order (answer recorded by an earlier run of this job).");
  return { order: orderOf(b, result, now), receiptId: null, outcome: status, receiptPending: true };
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
  SERVICE_METRICS.relayRefusals.inc(code);
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
  // arming is checked before anything is consumed, so the same signed envelope can go through once the host is armed
  if (o.checkAgent && !deps.flags.submitArmed()) {
    deps.log?.("relay not armed refusal", { venue: b.venue, buildId: b.build.buildId });
    return refuse(deps, "VENUE_ERROR", { ...ref, message: RELAY_NOT_ARMED });
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

/**
 * Where the gross cap starts counting (security r1 R1-06): a fresh positions read is the base and opening orders since
 * it (minus EXPOSURE_SLACK_MS) count on top; with no fresh read the base is 0 and every opening order since the policy
 * was issued counts. A positions read never shows a resting limit order, so resting orders count from the policy's
 * issue time whatever the read (R1-06 delta). Shared by the relay and the api build check.
 */
export async function grossWindow(exposure: ExposureSource | undefined, issuedAtMs: number | undefined, owner: Hex, venue: VenueId, nowMs: number): Promise<{ base: number; sinceMs: number; restingSinceMs: number }> {
  const restingSinceMs = issuedAtMs ?? 0;
  const fallback = { base: 0, sinceMs: restingSinceMs, restingSinceMs };
  if (!exposure) return fallback;
  const e = await exposure.openGrossUsd(owner, venue, nowMs).catch(() => null);
  const g = e ? Number(e.grossUsd) : Number.NaN;
  if (!e || !Number.isFinite(g) || g < 0 || !Number.isFinite(e.asOfMs) || e.asOfMs > nowMs) return fallback;
  const sinceMs = e.asOfMs - EXPOSURE_SLACK_MS;
  return { base: g, sinceMs, restingSinceMs: Math.min(restingSinceMs, sinceMs) };
}

export async function handleSubmit(req: SubmitRequest, ctx: SubmitContext, deps: RelayDeps): Promise<SubmitOutcome> {
  const env = req.signedEnvelope;
  const { b, venue, payloadHash, policy } = await loadAndVerify(req, deps, { checkAgent: true });
  const ref: RefuseOpts = { b, buildId: req.buildId, payloadHash };
  const now = deps.now();

  // 4: policy re-check (cancels always pass: they only remove risk). This early read refuses obvious breaches before
  // the eligibility call; the binding check runs again atomically with the order row in step 6 (security r1 R1-05).
  const governed = policy !== null && b.agentRef !== null && b.kind !== "cancel";
  const policyCheck = (usage: AgentUsage): ReserveCheck => {
    const p = b.build.preview;
    const r = checkPolicy({ policy: policy!.policy, agentRef: b.agentRef!, venue: b.venue, marketId: b.marketId, side: p.side, notionalUsd: p.notionalUsd, leverage: b.leverage, reduceOnly: p.reduceOnly, grossNotionalUsd: usage.grossNotionalUsd, ordersToday: usage.ordersToday, nowMs: now, mode: "relay" });
    return r.ok ? { ok: true } : { ok: false, field: r.field };
  };
  const breach = async (field: string): Promise<never> => {
    try {
      await deps.alerts.policyBreach({ owner: b.owner, agentRef: b.agentRef!, field, buildId: b.build.buildId });
    } catch (e) {
      deps.log?.("breach alert enqueue failed", { error: (e as Error).message });
    }
    return refuse(deps, "POLICY_BREACH", { ...ref, field, message: `The request breaches the agent policy (${field}).` });
  };
  // gross is open exposure, never a daily sum (security r1 R1-06): a fresh positions read plus the opening orders
  // since it (with a minute of slack for fills not yet in the read); without a fresh read, every opening order since
  // the policy was issued counts (over-counting only refuses earlier)
  const { base: grossBase, ...grossSince } = governed ? await grossWindow(deps.exposure, policy?.issuedAtMs, b.owner, b.venue, now) : { base: 0, sinceMs: 0, restingSinceMs: 0 };
  const withBase = (u: AgentUsage): AgentUsage => ({ ...u, grossNotionalUsd: (Number(u.grossNotionalUsd) + grossBase).toFixed(2) });
  if (governed) {
    const r = policyCheck(withBase(await deps.store.agentUsage(b.agentRef!, now, grossSince)));
    if (!r.ok) return breach(r.field);
  }

  // 5: eligibility with the submit IP (cancels and reduce-only closes always pass: a refused region can still exit)
  let decision: EligibilityDecision | null = null;
  if (b.kind === "order" && !b.build.preview.reduceOnly) {
    if (await deps.venueSignals.get(b.owner, b.venue, now)) return refuse(deps, "GEO_REFUSED", ref);
    decision = await deps.eligibility({ ip: ctx.ip, owner: b.owner, ...(b.agentRef ? { agentRef: b.agentRef } : {}), venue: b.venue, marketId: b.marketId, isEquityMarket: defaultIsEquity(b.marketId), action: "order" });
    if (!decision.allowed) return refuse(deps, (decision.code ?? "GEO_REFUSED") as ErrorCode, { ...ref, decisionId: decision.id });
  }

  // 6: dedupe on the recomputed payload hash
  // (under a policy: one atomic step with the usage read and the policy check, so concurrent submits cannot all pass)
  const orderId = deps.id();
  const row = { id: orderId, buildId: b.build.buildId, venue: b.venue, marketId: b.marketId, owner: b.owner.toLowerCase() as Hex, signedPayloadHash: payloadHash, mode: "relay" as const, status: "pending", builderFeeBps: b.build.preview.builderFeeBps, submittedAt: new Date(now) };
  if (governed) {
    const r = await deps.store.reserveAgentOrder(row, b.agentRef!, now, grossSince, (u) => policyCheck(withBase(u)));
    if (!r.ok && r.reason === "policy") return breach(r.field);
    if (!r.ok) {
      const replay = ctx.rerun ? await replayOf(deps, b, payloadHash, now) : null;
      if (replay) return replay;
      return refuse(deps, "DUPLICATE_PAYLOAD", ref);
    }
  } else if (!(await deps.store.insertOrder(row))) {
    const replay = ctx.rerun ? await replayOf(deps, b, payloadHash, now) : null;
    if (replay) return replay;
    return refuse(deps, "DUPLICATE_PAYLOAD", ref);
  }

  // 7: lanes. A reduce-only order is exit traffic, like a cancel or a close: counted by the exit lane (a much higher
  // per-minute cap than opens, security r1 R1-02) instead of the open lanes, and sent at safety priority (found on the fork run, todo 40: a spread's flatten of leg A was refused free_ip right
  // after leg A, which left the user unhedged). Eligibility treats it the same way in step 5.
  const exit = b.kind !== "order" || b.build.preview.reduceOnly === true;
  const { lane, perMin } = await deps.laneOf(b.owner, ctx.apiKey);
  const taken = await deps.lanes.take({ wallet: b.owner, ipBucket: ipBucket(ctx.ip), lane, perMin, kind: exit ? "close" : b.kind, nowMs: now });
  if (!taken.ok) {
    await deps.store.releaseOrder(orderId);
    return refuse(deps, "VENUE_RATE_LIMITED", { ...ref, message: DIRECT_MODE_HINT, field: taken.reason ?? "lane" });
  }

  // 8: governed submit, exactly once
  const priority: Priority = exit ? "safety" : lane;
  // exit traffic waits longer than an open but never forever (security r1 R1-02): past the deadline it is refused
  // with the direct-mode hint, so a budget-starved venue cannot park jobs indefinitely
  const deadlineMs = priority === "safety" ? (deps.safetyBudgetWaitMs ?? 30_000) : priority === "pro" ? (deps.proBudgetWaitMs ?? 10_000) : (deps.freeBudgetWaitMs ?? 2_000);
  let result: SubmitResult;
  try {
    result = await deps.dispatch.run(priority, async () => {
      const opts = { priority, deadlineMs };
      if (venue.lighterL1) await acquireLighterSubmit(deps.governor, venue.governorKey as "lighter-304" | "lighter-466324" | "lighter-300", venue.lighterL1(b), opts);
      else await deps.governor.acquire(venue.governorKey, venue.costOf(env), opts);
      try {
        recordGovernorUse(deps.governor.egress, venue.governorKey, deps.governor.usage(venue.governorKey).pct);
      } catch {
        // a metric never blocks a submit
      }
      recordFunnel("submit");
      try {
        return await venue.adapter.submit(env);
      } catch (e) {
        // the request may or may not have left: never resent, recorded as unknown
        return { status: "unknown", venueOrderId: null, txHash: null, venueResponse: String((e as Error).message ?? e).slice(0, 200), code: "VENUE_ERROR", message: "no clear answer from the venue" } satisfies SubmitResult;
      }
    }, venue.governorKey);
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
  // the venue answered (or may have): the order row records it first, and nothing after this line may throw, so the
  // caller always learns the venue's status and order id (security r1 R1-07). A receipt that cannot be issued now is
  // returned as pending; the receipt job keeps retrying with the same draft, so the receipt still appears.
  try {
    await deps.store.updateOrder(orderId, { status: result.status, venueOrderId: result.venueOrderId });
  } catch (e) {
    deps.log?.("order row update failed", { buildId: b.build.buildId, payloadHash, error: (e as Error).message });
  }
  let receiptId: string | null = null;
  let receiptJob: string | undefined;
  try {
    receiptId = (await deps.receipts.issue(venue.draft(b, env, result, payloadHash))).receiptId;
  } catch (e) {
    const job = (e as { receiptJob?: unknown }).receiptJob;
    if (typeof job === "string") receiptJob = job;
    deps.log?.("receipt pending", { buildId: b.build.buildId, payloadHash, error: (e as Error).message, ...(receiptJob ? { receiptJob } : {}) });
  }
  const pending = receiptId === null ? { receiptPending: true as const, ...(receiptJob ? { receiptJob } : {}) } : {};
  deps.log?.("submitted", { venue: b.venue, buildId: b.build.buildId, payloadHash, status: result.status, receiptId });
  if (result.status === "rejected") {
    const extra = receiptId ? { receiptId } : {};
    if (result.code === "BUILDER_APPROVAL_REQUIRED") throw new CapstanError("BUILDER_APPROVAL_REQUIRED", `${ERROR_BUILDER} ${BUILDER_HINT}`, extra);
    throw new CapstanError("VENUE_ERROR", `The venue refused the order: ${venueErrorText(result)}`, extra);
  }
  return { order: orderOf(b, result, now), receiptId, outcome: result.status, ...pending };
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
