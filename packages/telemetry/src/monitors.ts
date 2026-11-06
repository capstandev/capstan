// Read-only monitors that raise ops events. They notify only (MON-1): no monitor holds a reference to the relay,
// the kill switch or any venue flag, and none can change state anywhere.
import type { Db } from "@capstan/core";
import { db as schema, type VenueId } from "@capstan/schema";
import { count, eq, sql } from "drizzle-orm";
import type { OpsEvent } from "./causes";
import { recordGovernorUse, recordQuoteStaleness, recordUnhedgedPlans, recordUnmatchedFills } from "./metrics";

export type Emit = (e: OpsEvent) => Promise<void> | void;

export const STALE_THRESHOLD_MS = 3_000;
export const STALE_SUSTAIN_MS = 5 * 60_000;
/** Tier-one venues (spec 2): quotes refuse above 3 s. Variational and Arcus are data-only and never alert here. */
export const T1_VENUES = ["hyperliquid", "lighter-mainnet", "lighter-rh", "aster"] as const satisfies readonly VenueId[];

/** One `act` alert when a T1 venue's quote data stays older than 3 s for 5 minutes; one `info` on recovery. */
export class StalenessMonitor {
  private state = new Map<string, { since: number | null; alerted: boolean }>();
  constructor(
    private readonly emit: Emit,
    private readonly opts: { thresholdMs?: number; sustainMs?: number; tier1?: readonly string[] } = {},
  ) {}

  async observe(venue: string, staleMs: number, nowMs: number): Promise<void> {
    recordQuoteStaleness(venue, staleMs);
    const tier1 = this.opts.tier1 ?? T1_VENUES;
    if (!tier1.includes(venue)) return;
    const threshold = this.opts.thresholdMs ?? STALE_THRESHOLD_MS;
    const sustain = this.opts.sustainMs ?? STALE_SUSTAIN_MS;
    let s = this.state.get(venue);
    if (!s) this.state.set(venue, (s = { since: null, alerted: false }));
    if (staleMs > threshold) {
      if (s.since === null) s.since = nowMs;
      if (!s.alerted && nowMs - s.since >= sustain) {
        s.alerted = true;
        await this.emit({ kind: "quote.stale_t1", detail: { venue, staleMs: Math.round(staleMs), forMinutes: Math.round((nowMs - s.since) / 60_000) } });
      }
    } else {
      if (s.alerted) await this.emit({ kind: "quote.stale_t1_recovered", detail: { venue } });
      s.since = null;
      s.alerted = false;
    }
  }
}

/** Governor use above 90% raises one alert per budget until it falls under 80% again. */
export class GovernorMonitor {
  private alerted = new Set<string>();
  constructor(
    private readonly emit: Emit,
    private readonly opts: { alertPct?: number; clearPct?: number } = {},
  ) {}

  async observe(egress: string, venue: string, usedPct: number): Promise<void> {
    recordGovernorUse(egress, venue, usedPct);
    const budget = `${egress}:${venue}`;
    if (usedPct > (this.opts.alertPct ?? 90)) {
      if (!this.alerted.has(budget)) {
        this.alerted.add(budget);
        await this.emit({ kind: "governor.above_90", detail: { budget, usedPct: Math.round(usedPct * 10) / 10 } });
      }
    } else if (usedPct < (this.opts.clearPct ?? 80)) this.alerted.delete(budget);
  }
}

// ---- builder balances (spec 4.1, 4.4; DECISIONS #34) ----

export const HL_BUILDER_MIN_USDC = 100;
export const ASTER_BUILDER_MIN_ASTER = 100;

export interface HlBuilderReader {
  /** Perps account value in USDC (clearinghouseState marginSummary.accountValue). */
  accountValue(): Promise<string>;
  /** userAbstraction: "default" is the standard mode (read live 2026-11-06). */
  abstraction(): Promise<string>;
}

/** Aster builder Futures balance in ASTER. Signed builder read, so it runs on the VPS only; null = not available here. */
export interface AsterBuilderReader {
  futuresAster(): Promise<string | null>;
}

export const HL_STANDARD_ABSTRACTION = "default";

/** Public Hyperliquid info reads for the builder address (read-only, no key). */
export function hlBuilderReader(builder: string, http: typeof fetch = fetch, base = "https://api.hyperliquid.xyz"): HlBuilderReader {
  const info = async (body: Record<string, unknown>) => {
    const r = await http(`${base}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`hyperliquid info ${String(body.type)}: status ${r.status}`);
    return (await r.json()) as unknown;
  };
  return {
    async accountValue() {
      const j = (await info({ type: "clearinghouseState", user: builder })) as { marginSummary?: { accountValue?: string } };
      const v = j?.marginSummary?.accountValue;
      if (typeof v !== "string" || !/^-?\d+(\.\d+)?$/.test(v)) throw new Error("hyperliquid clearinghouseState: no accountValue");
      return v;
    },
    async abstraction() {
      const j = await info({ type: "userAbstraction", user: builder });
      if (typeof j !== "string") throw new Error("hyperliquid userAbstraction: not a string");
      return j;
    },
  };
}

export interface BuilderCheck {
  hl?: { accountValue: string | null; mode: string | null; ok: boolean };
  aster?: { balance: string | null; ok: boolean | null };
}

/** Read-only check of both builder wallets. Raises one event per problem; the ops-alerts dedupe keeps it to one message per 30 minutes. */
export async function checkBuilderBalances(deps: { hl?: HlBuilderReader; aster?: AsterBuilderReader; emit: Emit }): Promise<BuilderCheck> {
  const out: BuilderCheck = {};
  if (deps.hl) {
    let accountValue: string | null = null;
    let mode: string | null = null;
    try {
      [accountValue, mode] = await Promise.all([deps.hl.accountValue(), deps.hl.abstraction()]);
    } catch (e) {
      await deps.emit({ kind: "builder.read_failed", detail: { venue: "hyperliquid", error: (e as Error).message } });
    }
    let ok = accountValue !== null && mode !== null;
    if (accountValue !== null && Number(accountValue) < HL_BUILDER_MIN_USDC) {
      ok = false;
      await deps.emit({ kind: "builder.hl_low", detail: { accountValue, minimum: HL_BUILDER_MIN_USDC } });
    }
    if (mode !== null && mode !== HL_STANDARD_ABSTRACTION) {
      ok = false;
      await deps.emit({ kind: "builder.hl_not_standard", detail: { mode } });
    }
    out.hl = { accountValue, mode, ok };
  }
  if (deps.aster) {
    let balance: string | null = null;
    try {
      balance = await deps.aster.futuresAster();
    } catch (e) {
      await deps.emit({ kind: "builder.read_failed", detail: { venue: "aster", error: (e as Error).message } });
    }
    let ok: boolean | null = balance === null ? null : true;
    if (balance !== null && Number(balance) < ASTER_BUILDER_MIN_ASTER) {
      ok = false;
      await deps.emit({ kind: "builder.aster_low", detail: { balance, minimum: ASTER_BUILDER_MIN_ASTER } });
    }
    out.aster = { balance, ok };
  }
  return out;
}

// ---- gauges read from the database ----

/** unmatchedFills = the latest reconciled day's unmatched fills (all venues); unhedgedPlans = plans in `unhedged`. */
export async function refreshDbGauges(db: Db): Promise<{ unmatchedFills: number; unhedgedPlans: number }> {
  const [u] = await db
    .select({ n: sql<string>`coalesce(sum(${schema.builderFeeAccruals.unmatchedFills}), 0)` })
    .from(schema.builderFeeAccruals)
    .where(sql`${schema.builderFeeAccruals.day} = (select max(day) from builder_fee_accruals)`);
  const [p] = await db.select({ n: count() }).from(schema.spreadPlans).where(eq(schema.spreadPlans.status, "unhedged"));
  const unmatchedFills = Number(u?.n ?? 0);
  const unhedgedPlans = Number(p?.n ?? 0);
  recordUnmatchedFills(unmatchedFills);
  recordUnhedgedPlans(unhedgedPlans);
  return { unmatchedFills, unhedgedPlans };
}
