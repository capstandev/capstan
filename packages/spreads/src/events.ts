// Spread plan events (spec 7.5 step 7): the executor on the client posts each step; the server stores it, checks a
// reported fill against its own venue read (more than one lot apart: stored with mismatch true and an ops event),
// issues a spread.leg receipt per leg fill and a spread.plan receipt when the plan ends, and publishes on the plan
// channel. The server never executes, never moves collateral between venues and never rebalances anything.
// The log is bounded (R1-8-04): event data is allow-listed per kind and capped at 4 KB, a plan takes at most two leg B
// orders with one fill report each, leg B never reports more than leg A filled, and each step is stored atomically
// (the plan row is locked while its status and events are checked), so a racing duplicate gets no second receipt.
import { PUBSUB, schema, ulid, type Db } from "@capstan/core";
import { jcs, sha256Hex } from "@capstan/quote";
import { Dec, type Hex, type SpreadPlan, type VenueId } from "@capstan/schema";
import { asc, eq } from "drizzle-orm";
import { PlanError, type PlanStore, type StoredPlan } from "./plan";

export const EVENT_KINDS = ["leg_a_sent", "leg_a_filled", "leg_b_sent", "leg_b_filled", "unhedged", "flattened", "failed", "complete"] as const;
export type SpreadEventKind = (typeof EVENT_KINDS)[number];

export interface SpreadEventInput {
  kind: SpreadEventKind;
  data: unknown;
  signedPayloadHash?: Hex;
}

/** A receipt draft as packages/receipts builds it (kept structural so this package needs no receipt signer). */
export interface ReceiptPort {
  issue(action: "spread.leg" | "spread.plan", input: Record<string, unknown>): Promise<{ receiptId: string | null }>;
}

export interface EventDeps {
  store: PlanStore;
  events: EventLog;
  receipts: ReceiptPort;
  /** The venue's own read of an order's fill, or null when it cannot be read here. */
  venueFill?: (venue: VenueId, venueOrderId: string, owner: Hex) => Promise<{ filled: string } | null>;
  alert?: (x: { kind: "spreads.event_mismatch"; detail: Record<string, unknown> }) => Promise<void> | void;
  publish?: (channel: string, payload: unknown) => Promise<void>;
  policyIdFor?: (owner: Hex, venue: VenueId) => Promise<string | null>;
  now: () => Date;
}

export interface StoredEvent {
  id: string;
  planId: string;
  kind: SpreadEventKind;
  data: Record<string, unknown>;
  ts: string;
}

/** What a step decides once the plan is locked: the event to store and the plan's next status. */
export type StepDecision = (status: SpreadPlan["status"], events: StoredEvent[]) => { event: StoredEvent; status: SpreadPlan["status"] };

export interface EventLog {
  add(e: StoredEvent): Promise<void>;
  list(planId: string): Promise<StoredEvent[]>;
  /**
   * One step, atomically: lock the plan, read its status and events, run decide (it throws to refuse), then store the
   * event and the new status. Two racing posts of the same step cannot both pass.
   */
  append(planId: string, decide: StepDecision): Promise<{ from: SpreadPlan["status"]; to: SpreadPlan["status"] }>;
}

const TERMINAL = new Set<SpreadPlan["status"]>(["complete", "unhedged", "flattened", "failed"]);
/** Allowed next events per status. leg_b_filled keeps the status (the plan ends with complete, unhedged or flattened). */
const NEXT: Record<SpreadPlan["status"], SpreadEventKind[]> = {
  draft: [],
  acked: ["leg_a_sent", "failed"],
  leg_a_sent: ["leg_a_filled", "failed"],
  leg_a_filled: ["leg_b_sent", "unhedged", "flattened", "failed"],
  leg_b_sent: ["leg_b_filled", "leg_b_sent", "unhedged", "flattened", "complete"],
  complete: [],
  unhedged: ["flattened"],
  flattened: [],
  failed: [],
};
const STATUS_OF: Partial<Record<SpreadEventKind, SpreadPlan["status"]>> = {
  leg_a_sent: "leg_a_sent",
  leg_a_filled: "leg_a_filled",
  leg_b_sent: "leg_b_sent",
  unhedged: "unhedged",
  flattened: "flattened",
  failed: "failed",
  complete: "complete",
};

const S = 18;
const DEC = /^\d+(\.\d+)?$/;
const d = (x: string) => Dec.parse(x, S, "half_even");

/** Largest event data accepted, as JSON (R1-8-04). The executor's own events are well under 1 KB. */
export const MAX_EVENT_DATA_BYTES = 4096;
/** Leg B orders per plan: the first and one retry (retry_then_flatten). Each reports at most one fill. */
export const MAX_LEG_B_ORDERS = 2;

type Check = (v: unknown) => boolean;
const str =
  (max = 128): Check =>
  (v) => typeof v === "string" && v.length >= 1 && v.length <= max;
const orNull =
  (c: Check): Check =>
  (v) => v === null || c(v);
const dec: Check = (v) => typeof v === "string" && v.length <= 64 && DEC.test(v);
const bool: Check = (v) => typeof v === "boolean";
const notes: Check = (v) => Array.isArray(v) && v.length <= 4 && v.every(str(200));
const reason = str(600);
const SENT = { buildId: orNull(str()), venueOrderId: orNull(str()), size: dec };
const FILL = { buildId: str(), venueOrderId: str(), filled: dec, avgPx: orNull(str(64)), final: bool, eligibilityDecisionId: str() };
const END = { residualDeltaBase: dec, reason, legAFilled: dec, legBFilled: dec, stateUnknown: notes };
/** The data keys each kind may carry (what the executor posts); anything else is refused. */
const FIELDS: Record<SpreadEventKind, Record<string, Check>> = {
  leg_a_sent: SENT,
  leg_b_sent: { ...SENT, retry: bool },
  leg_a_filled: FILL,
  leg_b_filled: FILL,
  unhedged: END,
  complete: END,
  flattened: { ...END, buildId: orNull(str()), venueOrderId: orNull(str()), filled: dec },
  failed: { reason, stateUnknown: (v) => bool(v) || notes(v) },
};

function checkData(kind: SpreadEventKind, raw: unknown): Record<string, unknown> {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(raw ?? {}));
  } catch {
    throw new PlanError("INVALID_INPUT", "event data must be JSON");
  }
  if (size > MAX_EVENT_DATA_BYTES) throw new PlanError("INVALID_INPUT", `event data is over ${MAX_EVENT_DATA_BYTES} bytes`);
  const data = { ...obj(raw) };
  const allowed = FIELDS[kind];
  for (const [k, v] of Object.entries(data)) {
    // own names only: an inherited Object.prototype name (constructor, __proto__) is never a field (R2-SPREADS-01)
    const c = Object.hasOwn(allowed, k) ? allowed[k] : undefined;
    if (!c) throw new PlanError("INVALID_INPUT", `event data.${k} is not accepted for ${kind}`);
    if (v !== undefined && !c(v)) throw new PlanError("INVALID_INPUT", `event data.${k} is not valid`);
  }
  return data;
}

/** The checks that need the plan's current status and events; run with the plan locked. */
function checkStep(kind: SpreadEventKind, data: Record<string, unknown>, status: SpreadPlan["status"], events: StoredEvent[] | null): void {
  if (status === "draft") throw new PlanError("BAD_STATE", "the plan must be acknowledged first");
  if (!NEXT[status].includes(kind)) throw new PlanError("BAD_STATE", `${kind} cannot follow ${status}`);
  if (!events) return;
  const count = (k: SpreadEventKind) => events.filter((e) => e.kind === k).length;
  if (kind === "leg_b_sent" && count("leg_b_sent") >= MAX_LEG_B_ORDERS) throw new PlanError("BAD_STATE", `a plan sends at most ${MAX_LEG_B_ORDERS} leg B orders`);
  if (kind === "leg_b_filled") {
    if (count("leg_b_filled") >= count("leg_b_sent")) throw new PlanError("BAD_STATE", "each leg B order reports one fill");
    const aEv = events.find((e) => e.kind === "leg_a_filled");
    const aFilled = typeof aEv?.data.filled === "string" && DEC.test(aEv.data.filled) ? d(aEv.data.filled) : d("0");
    let sum = d(data.filled as string);
    for (const e of events) if (e.kind === "leg_b_filled" && typeof e.data.filled === "string" && DEC.test(e.data.filled)) sum = Dec.add(sum, d(e.data.filled));
    if (Dec.cmp(sum, aFilled) > 0) throw new PlanError("INVALID_INPUT", "leg B cannot fill more than leg A filled");
  }
}

function obj(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function need(data: Record<string, unknown>, k: string, re: RegExp = /^.{1,128}$/): string {
  const v = data[k];
  if (typeof v !== "string" || !re.test(v)) throw new PlanError("INVALID_INPUT", `event data.${k} is required`);
  return v;
}

function lotOf(p: SpreadPlan, leg: "a" | "b"): string {
  const t = (leg === "a" ? p.legA : p.legB).payloadTemplate.payload as { lotSize?: unknown };
  return typeof t?.lotSize === "string" && DEC.test(t.lotSize) ? t.lotSize : "0";
}

export async function recordEvent(planId: string, ev: SpreadEventInput, deps: EventDeps): Promise<{ status: SpreadPlan["status"]; mismatch: boolean | null; receiptIds: string[] }> {
  if (!(EVENT_KINDS as readonly string[]).includes(ev.kind)) throw new PlanError("INVALID_INPUT", `unknown event kind ${String(ev.kind)}`);
  const data = checkData(ev.kind, ev.data);
  const sp: StoredPlan | null = await deps.store.get(planId);
  if (!sp) throw new PlanError("NOT_FOUND", "unknown plan");
  const p = sp.plan;
  // a cheap early refusal before any venue read; the same checks run again with the plan locked
  checkStep(ev.kind, data, p.status, null);
  const now = deps.now();
  let mismatch: boolean | null = null;
  let mismatchAlert: Record<string, unknown> | null = null;
  const receiptIds: string[] = [];
  const legOf = (k: SpreadEventKind): "a" | "b" | null => (k.startsWith("leg_a") ? "a" : k.startsWith("leg_b") ? "b" : k === "flattened" ? "a" : null);
  const isFill = ev.kind === "leg_a_filled" || ev.kind === "leg_b_filled";
  const leg = isFill ? legOf(ev.kind)! : null;
  const L = leg === "b" ? p.legB : p.legA;
  let fill: { buildId: string; venueOrderId: string; filled: string } | null = null;

  if (isFill) {
    const buildId = need(data, "buildId");
    const venueOrderId = need(data, "venueOrderId");
    const filled = need(data, "filled", DEC);
    if (Dec.cmp(d(filled), d(L.size)) > 0) throw new PlanError("INVALID_INPUT", `leg ${leg!.toUpperCase()} cannot fill more than its size`);
    fill = { buildId, venueOrderId, filled };
    // cross-check against the venue's own read (more than one lot apart is a mismatch)
    const read = deps.venueFill ? await deps.venueFill(L.venue, venueOrderId, sp.owner).catch(() => null) : null;
    if (read && DEC.test(read.filled)) {
      const lot = lotOf(p, leg!);
      const gap = Dec.abs(Dec.sub(d(filled), d(read.filled)));
      mismatch = Dec.cmp(gap, d(lot === "0" ? "0" : lot)) > 0;
      data.venueFilled = read.filled;
      if (mismatch) mismatchAlert = { planId, eventKind: ev.kind, reported: filled, venueRead: read.filled, venue: L.venue };
    }
    data.mismatch = mismatch;
  }
  if (ev.kind === "unhedged" || ev.kind === "flattened" || ev.kind === "complete") need(data, "residualDeltaBase", DEC);

  const event: StoredEvent = { id: ulid(now.getTime()), planId, kind: ev.kind, data: { ...data, ...(ev.signedPayloadHash ? { signedPayloadHash: ev.signedPayloadHash } : {}) }, ts: now.toISOString() };
  const step = await deps.events.append(planId, (status, events) => {
    checkStep(ev.kind, data, status, events);
    return { event, status: STATUS_OF[ev.kind] ?? status };
  });
  // receipts and alerts only for a step that was stored
  if (mismatchAlert) await deps.alert?.({ kind: "spreads.event_mismatch", detail: mismatchAlert });
  if (fill) {
    const policyId = (deps.policyIdFor ? await deps.policyIdFor(sp.owner, L.venue).catch(() => null) : null) ?? "none";
    const r = await deps.receipts.issue("spread.leg", {
      owner: sp.owner,
      venue: L.venue,
      marketId: L.marketId,
      canonicalAsset: p.canonicalAsset,
      buildId: fill.buildId,
      policyId,
      venueOrderId: fill.venueOrderId,
      signedPayloadHash: ev.signedPayloadHash ?? null,
      requestHash: sha256Hex(jcs({ planId, kind: ev.kind, data: fill })),
      eligibilityDecisionId: typeof data.eligibilityDecisionId === "string" ? data.eligibilityDecisionId : `plan:${planId}`,
    });
    if (r.receiptId) receiptIds.push(r.receiptId);
  }
  const status = step.to;
  if (TERMINAL.has(status) && !TERMINAL.has(step.from)) {
    const r = await deps.receipts.issue("spread.plan", { owner: sp.owner, canonicalAsset: p.canonicalAsset, quoteSnapshotHash: sp.quoteSnapshotHash, requestHash: sha256Hex(jcs({ planId, final: status, data })), eligibilityDecisionId: `plan:${planId}` });
    if (r.receiptId) receiptIds.push(r.receiptId);
  }
  await deps.publish?.(PUBSUB.plan(planId), { planId, kind: ev.kind, status, mismatch, ts: now.toISOString() });
  return { status, mismatch, receiptIds };
}

/** Postgres store: spread_plans (plan jsonb carries the quote snapshot hash), spread_events and quote_snapshots. */
export function dbPlanStore(db: Db): PlanStore & EventLog {
  return {
    async insert(sp, quoteBody) {
      await db.insert(schema.quoteSnapshots).values({ id: `plan-${sp.plan.planId}`, hash: sp.quoteSnapshotHash, body: quoteBody }).onConflictDoNothing();
      await db.insert(schema.spreadPlans).values({ id: sp.plan.planId, owner: sp.owner.toLowerCase(), equivalenceId: sp.plan.equivalenceId, plan: { plan: sp.plan, quoteSnapshotHash: sp.quoteSnapshotHash }, ackSig: sp.ackSig, status: sp.plan.status });
    },
    async get(planId) {
      const [r] = await db.select().from(schema.spreadPlans).where(eq(schema.spreadPlans.id, planId)).limit(1);
      if (!r) return null;
      const j = r.plan as { plan: SpreadPlan; quoteSnapshotHash: Hex };
      return { plan: { ...j.plan, status: r.status as SpreadPlan["status"] }, owner: r.owner as Hex, ackSig: r.ackSig, quoteSnapshotHash: j.quoteSnapshotHash };
    },
    async setStatus(planId, status, ackSig) {
      await db.update(schema.spreadPlans).set({ status, ...(ackSig ? { ackSig } : {}) }).where(eq(schema.spreadPlans.id, planId));
    },
    async add(e) {
      await db.insert(schema.spreadEvents).values({ id: e.id, planId: e.planId, kind: e.kind, data: e.data, ts: new Date(e.ts) });
    },
    async list(planId) {
      const rows = await db.select().from(schema.spreadEvents).where(eq(schema.spreadEvents.planId, planId)).orderBy(asc(schema.spreadEvents.ts), asc(schema.spreadEvents.id));
      return rows.map(eventOf);
    },
    async append(planId, decide) {
      // one transaction on one connection: the plan row stays locked (FOR UPDATE) until the event and status are in,
      // so a racing post waits and then sees the new status; the holder never needs a second pool connection
      return db.transaction(async (tx) => {
        const [row] = await tx.select({ status: schema.spreadPlans.status }).from(schema.spreadPlans).where(eq(schema.spreadPlans.id, planId)).for("update").limit(1);
        if (!row) throw new PlanError("NOT_FOUND", "unknown plan");
        const from = row.status as SpreadPlan["status"];
        const rows = await tx.select().from(schema.spreadEvents).where(eq(schema.spreadEvents.planId, planId)).orderBy(asc(schema.spreadEvents.ts), asc(schema.spreadEvents.id));
        const { event: e, status } = decide(from, rows.map(eventOf));
        await tx.insert(schema.spreadEvents).values({ id: e.id, planId: e.planId, kind: e.kind, data: e.data, ts: new Date(e.ts) });
        if (status !== from) await tx.update(schema.spreadPlans).set({ status }).where(eq(schema.spreadPlans.id, planId));
        return { from, to: status };
      });
    },
  };
}

function eventOf(r: typeof schema.spreadEvents.$inferSelect): StoredEvent {
  return { id: r.id, planId: r.planId, kind: r.kind as SpreadEventKind, data: r.data as Record<string, unknown>, ts: r.ts.toISOString() };
}

/** In-memory store (tests, tools). */
export function memoryPlanStore(): PlanStore & EventLog & { quotes: Map<string, unknown> } {
  const plans = new Map<string, StoredPlan>();
  const evs: StoredEvent[] = [];
  const quotes = new Map<string, unknown>();
  return {
    quotes,
    async insert(sp, body) {
      plans.set(sp.plan.planId, structuredClone(sp));
      quotes.set(sp.quoteSnapshotHash, body);
    },
    async get(id) {
      const v = plans.get(id);
      return v ? structuredClone(v) : null;
    },
    async setStatus(id, status, ackSig) {
      const v = plans.get(id);
      if (v) {
        v.plan.status = status;
        if (ackSig) v.ackSig = ackSig;
      }
    },
    async add(e) {
      evs.push(structuredClone(e));
    },
    async list(id) {
      return evs.filter((e) => e.planId === id).map((e) => structuredClone(e));
    },
    // no await between the read and the writes: atomic on the one JS thread
    async append(id, decide) {
      const v = plans.get(id);
      if (!v) throw new PlanError("NOT_FOUND", "unknown plan");
      const from = v.plan.status;
      const { event: e, status } = decide(from, evs.filter((x) => x.planId === id).map((x) => structuredClone(x)));
      evs.push(structuredClone(e));
      v.plan.status = status;
      return { from, to: status };
    },
  };
}
