// Spread plan events (spec 7.5 step 7): the executor on the client posts each step; the server stores it, checks a
// reported fill against its own venue read (more than one lot apart: stored with mismatch true and an ops event),
// issues a spread.leg receipt per leg fill and a spread.plan receipt when the plan ends, and publishes on the plan
// channel. The server never executes, never moves collateral between venues and never rebalances anything.
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

export interface EventLog {
  add(e: StoredEvent): Promise<void>;
  list(planId: string): Promise<StoredEvent[]>;
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
  const sp: StoredPlan | null = await deps.store.get(planId);
  if (!sp) throw new PlanError("NOT_FOUND", "unknown plan");
  const p = sp.plan;
  if (p.status === "draft") throw new PlanError("BAD_STATE", "the plan must be acknowledged first");
  if (!NEXT[p.status].includes(ev.kind)) throw new PlanError("BAD_STATE", `${ev.kind} cannot follow ${p.status}`);
  const data = { ...obj(ev.data) };
  const now = deps.now();
  let mismatch: boolean | null = null;
  const receiptIds: string[] = [];
  const legOf = (k: SpreadEventKind): "a" | "b" | null => (k.startsWith("leg_a") ? "a" : k.startsWith("leg_b") ? "b" : k === "flattened" ? "a" : null);

  if (ev.kind === "leg_a_filled" || ev.kind === "leg_b_filled") {
    const leg = legOf(ev.kind)!;
    const L = leg === "a" ? p.legA : p.legB;
    const buildId = need(data, "buildId");
    const venueOrderId = need(data, "venueOrderId");
    const filled = need(data, "filled", DEC);
    if (Dec.cmp(d(filled), d(L.size)) > 0 && leg === "a") throw new PlanError("INVALID_INPUT", "leg A cannot fill more than its size");
    // cross-check against the venue's own read (more than one lot apart is a mismatch)
    const read = deps.venueFill ? await deps.venueFill(L.venue, venueOrderId, sp.owner).catch(() => null) : null;
    if (read && DEC.test(read.filled)) {
      const lot = lotOf(p, leg);
      const gap = Dec.abs(Dec.sub(d(filled), d(read.filled)));
      mismatch = Dec.cmp(gap, d(lot === "0" ? "0" : lot)) > 0;
      data.venueFilled = read.filled;
      if (mismatch) await deps.alert?.({ kind: "spreads.event_mismatch", detail: { planId, eventKind: ev.kind, reported: filled, venueRead: read.filled, venue: L.venue } });
    }
    data.mismatch = mismatch;
    const policyId = (deps.policyIdFor ? await deps.policyIdFor(sp.owner, L.venue).catch(() => null) : null) ?? "none";
    const r = await deps.receipts.issue("spread.leg", {
      owner: sp.owner,
      venue: L.venue,
      marketId: L.marketId,
      canonicalAsset: p.canonicalAsset,
      buildId,
      policyId,
      venueOrderId,
      signedPayloadHash: ev.signedPayloadHash ?? null,
      requestHash: sha256Hex(jcs({ planId, kind: ev.kind, data: { buildId, venueOrderId, filled } })),
      eligibilityDecisionId: typeof data.eligibilityDecisionId === "string" ? data.eligibilityDecisionId : `plan:${planId}`,
    });
    if (r.receiptId) receiptIds.push(r.receiptId);
  }
  if (ev.kind === "unhedged" || ev.kind === "flattened" || ev.kind === "complete") need(data, "residualDeltaBase", DEC);

  await deps.events.add({ id: ulid(now.getTime()), planId, kind: ev.kind, data: { ...data, ...(ev.signedPayloadHash ? { signedPayloadHash: ev.signedPayloadHash } : {}) }, ts: now.toISOString() });
  const status = STATUS_OF[ev.kind] ?? p.status;
  if (status !== p.status) await deps.store.setStatus(planId, status);
  if (TERMINAL.has(status) && !TERMINAL.has(p.status)) {
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
      return rows.map((r) => ({ id: r.id, planId: r.planId, kind: r.kind as SpreadEventKind, data: r.data as Record<string, unknown>, ts: r.ts.toISOString() }));
    },
  };
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
  };
}
