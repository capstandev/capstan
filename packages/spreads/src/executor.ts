// Client-side spread executor (spec 7.5 steps 5 to 7). It runs where the keys are (the SDK or an MCP host), never on
// the server: no server module imports it. Legging risk is yours: leg A (the less liquid leg) goes first as an IOC;
// leg B is sized to leg A's ACTUAL fill, rounded down to leg B's lot (the remainder is reported as residual); if leg B
// fails or fills only partly, the plan's hedgeFailurePolicy applies:
//   leave_open          the plan ends 'unhedged' with the residual reported
//   flatten_leg_a       a reduce-only IOC on leg A for the unhedged amount, signed by leg A's key, ends 'flattened'
//   retry_then_flatten  one leg B retry within the leg timeout, then the flatten
// After a failure it never sends another opening order, and it never sends leg B larger than leg A's fill. Every step
// is posted as an event. This module imports only the schema: no server code, no keys of its own.
import { Dec, type OrderIntent, type SignedEnvelope, type SpreadPlan, type SubmitResult, type UnsignedVenuePayload, type VenueId } from "@capstan/schema";

export const POLL_MS = 250;

const FNV128_OFFSET = 0x6c62272e07bb014262b821756295c58dn;
const FNV128_PRIME = 0x0000000001000000000000000000013bn;
const MASK128 = (1n << 128n) - 1n;

/**
 * The client order id of one leg order, in the form its venue accepts. Hyperliquid takes only 0x + 32 hex (a cloid):
 * a 128-bit FNV-1a of `<planId>:<leg>`, so each leg of each plan has its own id and the same leg always gets the same
 * one. Other venues keep `<planId>-<leg>` (Aster allows 36 characters; Lighter numbers its own client order index).
 * Found on the fork run (todo 40): `<planId>-a` made every Hyperliquid leg build fail.
 */
export function legClientOrderId(planId: string, which: string, venue: VenueId): string {
  if (venue !== "hyperliquid") return `${planId}-${which}`;
  let h = FNV128_OFFSET;
  for (const b of new TextEncoder().encode(`${planId}:${which}`)) h = ((h ^ BigInt(b)) * FNV128_PRIME) & MASK128;
  return `0x${h.toString(16).padStart(32, "0")}`;
}

export type ExecutorEvent = {
  kind: "leg_a_sent" | "leg_a_filled" | "leg_b_sent" | "leg_b_filled" | "unhedged" | "flattened" | "failed" | "complete";
  data: unknown;
  signedPayloadHash?: `0x${string}`;
};

export interface ExecutorPorts {
  build(intent: OrderIntent, venue: VenueId): Promise<UnsignedVenuePayload>;
  sign(p: UnsignedVenuePayload): Promise<SignedEnvelope>;
  submit(env: SignedEnvelope): Promise<SubmitResult>;
  fillOf(venue: VenueId, venueOrderId: string): Promise<{ filled: string; avgPx: string | null; done: boolean }>;
  post(ev: ExecutorEvent): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Agent-safe policy check before each build (relay mode); a refusal stops that order. */
  checkPolicy?(intent: OrderIntent, venue: VenueId): { ok: true } | { ok: false; field: string };
  /** Lot size of a market; defaults to the plan template's lotSize. */
  lotOf?(marketId: string): string;
}

export interface ExecuteResult {
  status: SpreadPlan["status"];
  residualDeltaBase: string;
  legAFilled: string;
  legBFilled: string;
  unposted?: number; // events the server did not accept (the result still reports everything)
}

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorError";
  }
}

const S = 18;
const ZERO = Dec.parse("0", S);
const DECRE = /^\d+(\.\d+)?$/;
const d = (x: string) => Dec.parse(x, S, "half_even");
const s = (x: Dec) => Dec.toString(x);
const pos = (x: Dec) => Dec.cmp(x, ZERO) > 0;
const floorLot = (x: Dec, lot: string) => (DECRE.test(lot) && pos(d(lot)) ? Dec.roundToStep(x, d(lot), "down") : x);

interface Sent {
  sent: boolean;
  accepted: boolean;
  done: boolean; // the venue said the order is finished (an IOC settles at once; unknown otherwise)
  buildId: string | null;
  venueOrderId: string | null;
  filled: Dec;
  avgPx: string | null;
  signedPayloadHash?: `0x${string}`;
  reason?: string;
}

function lotOfLeg(p: SpreadPlan, leg: "a" | "b", ports: ExecutorPorts): string {
  const L = leg === "a" ? p.legA : p.legB;
  const fromPort = ports.lotOf?.(L.marketId);
  if (fromPort && DECRE.test(fromPort)) return fromPort;
  const t = L.payloadTemplate?.payload as { lotSize?: unknown } | undefined;
  return typeof t?.lotSize === "string" && DECRE.test(t.lotSize) ? t.lotSize : "0";
}

/** Build, sign and submit one IOC, then poll its fill every 250 ms until the venue says done or the deadline passes. */
async function sendIoc(intent: OrderIntent, venue: VenueId, deadline: number, ports: ExecutorPorts): Promise<Sent> {
  const none: Sent = { sent: false, accepted: false, done: true, buildId: null, venueOrderId: null, filled: ZERO, avgPx: null };
  const pc = ports.checkPolicy?.(intent, venue);
  if (pc && !pc.ok) return { ...none, reason: `policy refused (${pc.field})` };
  let build: UnsignedVenuePayload;
  let env: SignedEnvelope;
  try {
    build = await ports.build(intent, venue);
    env = await ports.sign(build);
  } catch (e) {
    return { ...none, reason: `build or sign failed: ${(e as Error).message}`.slice(0, 200) };
  }
  let res: SubmitResult;
  try {
    res = await ports.submit(env);
  } catch (e) {
    res = { status: "unknown", venueOrderId: null, txHash: null, venueResponse: null, message: (e as Error).message };
  }
  const base: Sent = { sent: true, accepted: res.status !== "rejected", done: res.status === "rejected", buildId: build.buildId, venueOrderId: res.venueOrderId, filled: ZERO, avgPx: null, signedPayloadHash: env.payloadHash as `0x${string}` };
  if (res.status === "rejected") return { ...base, reason: `rejected${res.code ? ` (${res.code})` : ""}` };
  if (!res.venueOrderId) return { ...base, done: false, reason: "the venue gave no order id; the fill could not be read" };
  // poll until the venue says done; past the leg deadline keep reading (up to the same span again) only to learn the
  // final state, never to send anything
  const hardStop = deadline + Math.max(0, deadline - ports.now());
  for (;;) {
    let f: { filled: string; avgPx: string | null; done: boolean } | null = null;
    try {
      f = await ports.fillOf(venue, res.venueOrderId);
    } catch {
      f = null;
    }
    if (f && DECRE.test(f.filled)) {
      const v = d(f.filled);
      // a venue read never goes backwards and never exceeds what was sent
      if (Dec.cmp(v, base.filled) > 0) base.filled = Dec.min(v, d(intent.size));
      base.avgPx = f.avgPx;
      if (f.done) {
        base.done = true;
        break;
      }
    }
    if (ports.now() >= hardStop) break;
    await ports.sleep(POLL_MS);
  }
  return base;
}

export async function execute(p: SpreadPlan, ports: ExecutorPorts): Promise<ExecuteResult> {
  if (p.status !== "acked") throw new ExecutorError(`the plan must be acknowledged first (status ${p.status})`);
  if (p.riskLabel !== "At-risk. Legging risk is yours." || p.ackRequired !== true) throw new ExecutorError("not a spread plan this executor knows");
  let unposted = 0;
  const post = async (ev: ExecutorEvent) => {
    try {
      await ports.post(ev);
    } catch {
      unposted++;
    }
  };
  const done = (status: SpreadPlan["status"], residual: Dec, a: Dec, b: Dec): ExecuteResult => ({ status, residualDeltaBase: s(residual), legAFilled: s(a), legBFilled: s(b), ...(unposted ? { unposted } : {}) });
  const lotA = lotOfLeg(p, "a", ports);
  const lotB = lotOfLeg(p, "b", ports);
  const slip = p.maxLegSlippageBps;
  const ioc = (leg: SpreadPlan["legA"], size: Dec, which: string, reduceOnly = false, side: "buy" | "sell" = leg.side): OrderIntent => ({ marketId: leg.marketId, side, size: s(size), type: "market", tif: "ioc", reduceOnly, clientOrderId: legClientOrderId(p.planId, which, leg.venue), maxSlippageBps: slip });

  // ---- leg A
  const aSize = floorLot(d(p.legA.size), lotA);
  if (!pos(aSize)) {
    await post({ kind: "failed", data: { reason: "leg A size rounds to zero" } });
    return done("failed", ZERO, ZERO, ZERO);
  }
  const a = await sendIoc(ioc(p.legA, aSize, "a"), p.legA.venue, ports.now() + p.legTimeoutMs, ports);
  if (!a.sent) {
    await post({ kind: "failed", data: { reason: a.reason } });
    return done("failed", ZERO, ZERO, ZERO);
  }
  await post({ kind: "leg_a_sent", data: { buildId: a.buildId, venueOrderId: a.venueOrderId, size: s(aSize) }, ...(a.signedPayloadHash ? { signedPayloadHash: a.signedPayloadHash } : {}) });
  if (!pos(a.filled)) {
    // leg A rejected or unfilled within the timeout: leg B is never sent and nothing needs flattening. When the venue
    // never confirmed the order finished, the event says so: check the venue for a late fill.
    await post({ kind: "failed", data: { reason: a.reason ?? "leg A did not fill within the leg timeout", ...(a.done ? {} : { stateUnknown: true }) } });
    return done("failed", ZERO, ZERO, ZERO);
  }
  const filledA = a.filled;
  // unknown final states are carried into the closing event so a late fill is never silently left out
  const unknown: string[] = a.done ? [] : ["leg A not confirmed finished: a later fill would add to the residual"];
  await post({ kind: "leg_a_filled", data: { buildId: a.buildId, venueOrderId: a.venueOrderId, filled: s(filledA), avgPx: a.avgPx, ...(a.done ? {} : { final: false }) } });

  // ---- leg B: sized to A's actual fill, rounded down to B's lot
  const sizeB = floorLot(filledA, lotB);
  let filledB = ZERO;
  let bReason = "leg B size rounds to zero";
  let bUnknown = false;
  const bDeadline = ports.now() + p.legTimeoutMs;
  const attempts = p.hedgeFailurePolicy === "retry_then_flatten" ? 2 : 1;
  for (let i = 0; i < attempts; i++) {
    const want = floorLot(Dec.sub(sizeB, filledB), lotB);
    if (!pos(want)) break;
    if (i > 0 && ports.now() >= bDeadline) {
      bReason = "no time left for the leg B retry";
      break;
    }
    const b = await sendIoc(ioc(p.legB, want, i === 0 ? "b" : "b2"), p.legB.venue, bDeadline, ports);
    if (!b.sent) {
      bReason = b.reason ?? "leg B was not sent";
      break; // a policy or build refusal does not change on a retry
    }
    await post({ kind: "leg_b_sent", data: { buildId: b.buildId, venueOrderId: b.venueOrderId, size: s(want), ...(i > 0 ? { retry: true } : {}) }, ...(b.signedPayloadHash ? { signedPayloadHash: b.signedPayloadHash } : {}) });
    if (pos(b.filled)) {
      filledB = Dec.add(filledB, b.filled);
      await post({ kind: "leg_b_filled", data: { buildId: b.buildId, venueOrderId: b.venueOrderId, filled: s(b.filled), avgPx: b.avgPx, ...(b.done ? {} : { final: false }) } });
    }
    bReason = b.reason ?? (Dec.cmp(filledB, sizeB) < 0 ? "leg B filled only partly" : "");
    if (!b.done) {
      // never stack another order on one whose state is unknown: no retry and no flatten
      bUnknown = true;
      unknown.push("leg B not confirmed finished: a later fill would reduce the residual");
      break;
    }
    if (pos(sizeB) && Dec.eq(filledB, sizeB)) break;
  }
  if (pos(sizeB) && Dec.eq(filledB, sizeB)) {
    const residual = Dec.sub(filledA, filledB); // the lot rounding remainder, reported exactly
    await post({ kind: "complete", data: { residualDeltaBase: s(residual), legAFilled: s(filledA), legBFilled: s(filledB), ...(unknown.length ? { stateUnknown: unknown } : {}) } });
    return done("complete", residual, filledA, filledB);
  }

  // ---- leg B failed or filled only partly: the hedge-failure policy, never another opening order
  const unhedged = Dec.sub(filledA, filledB);
  if (p.hedgeFailurePolicy === "leave_open" || bUnknown) {
    await post({ kind: "unhedged", data: { residualDeltaBase: s(unhedged), reason: bReason, legAFilled: s(filledA), legBFilled: s(filledB), ...(unknown.length ? { stateUnknown: unknown } : {}) } });
    return done("unhedged", unhedged, filledA, filledB);
  }
  const flatSize = floorLot(unhedged, lotA);
  let flat: Sent | null = null;
  if (pos(flatSize)) {
    const back = p.legA.side === "buy" ? "sell" : "buy";
    flat = await sendIoc(ioc(p.legA, flatSize, "a-flat", true, back), p.legA.venue, ports.now() + p.legTimeoutMs, ports);
  }
  const flatFilled = flat?.filled ?? ZERO;
  const residual = Dec.sub(unhedged, flatFilled);
  if (!pos(flatFilled)) {
    if (flat && !flat.done) unknown.push("flatten not confirmed finished: a later fill would reduce the residual");
    await post({ kind: "unhedged", data: { residualDeltaBase: s(residual), reason: `${bReason}; the flatten did not fill${flat?.reason ? ` (${flat.reason})` : ""}`, legAFilled: s(filledA), legBFilled: s(filledB), ...(unknown.length ? { stateUnknown: unknown } : {}) } });
    return done("unhedged", residual, filledA, filledB);
  }
  if (!flat!.done) unknown.push("flatten not confirmed finished: a later fill would reduce the residual");
  await post({ kind: "flattened", data: { residualDeltaBase: s(residual), buildId: flat!.buildId, venueOrderId: flat!.venueOrderId, filled: s(flatFilled), reason: bReason, legAFilled: s(filledA), legBFilled: s(filledB), ...(unknown.length ? { stateUnknown: unknown } : {}) }, ...(flat!.signedPayloadHash ? { signedPayloadHash: flat!.signedPayloadHash } : {}) });
  return done("flattened", residual, filledA, filledB);
}
