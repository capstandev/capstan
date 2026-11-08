// Pro credits (prepaid premium calls), in USD, in api_accounts.credits with every change in credit_ledger.
// - topUpCredits adds a settled x402 payment once (idempotent on the settlement id, under a row lock);
// - spendCredit subtracts atomically and never lets the balance go negative (a conditional UPDATE);
// - all arithmetic is Postgres numeric, never floating point.
import { schema, ulid, type Db } from "@capstan/core";
import { and, desc, eq, gt, or, sql } from "drizzle-orm";

/** A settled x402 payment to a top-up route (built from the facilitator's settle result). */
export interface X402SettlementRecord {
  /** Unique per settlement: `${network}:${transaction}`. */
  id: string;
  network: string;
  asset: string;
  /** Atomic token units. */
  amount: string;
  decimals: number;
  payer: string;
  status: "settled";
}

/** Top-up packs in USD (POST /v1/credits/topup/<pack>). */
export const TOPUP_PACKS = ["5", "20", "100"] as const;
export type TopupPack = (typeof TOPUP_PACKS)[number];

const USD_RE = /^\d{1,12}(\.\d{1,6})?$/;

export class CreditsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditsError";
  }
}

/** Atomic units of a 1-USD token to a decimal USD string (exact). */
export function atomicToUsd(amount: string, decimals: number): string {
  if (!/^\d{1,40}$/.test(amount) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new CreditsError("bad amount");
  const s = amount.padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

/** Credit a settled top-up once. Returns false when this settlement was already credited. */
export async function topUpCredits(db: Db, accountId: string, settlement: X402SettlementRecord): Promise<boolean> {
  if (settlement.status !== "settled") throw new CreditsError("only a settled payment can top up credits");
  const usd = atomicToUsd(settlement.amount, settlement.decimals);
  if (!(Number(usd) > 0)) throw new CreditsError("a top-up of amount 0 is refused");
  return db.transaction(async (tx) => {
    const acct = await tx.execute(sql`select id from api_accounts where id = ${accountId} for update`);
    if (!acct.length) throw new CreditsError("unknown account");
    const ref = `x402:${settlement.id}`;
    const seen = await tx.select({ id: schema.creditLedger.id }).from(schema.creditLedger).where(and(eq(schema.creditLedger.accountId, accountId), eq(schema.creditLedger.ref, ref)));
    if (seen.length) return false;
    // the same settlement may never credit two accounts either
    const elsewhere = await tx.select({ id: schema.creditLedger.id }).from(schema.creditLedger).where(eq(schema.creditLedger.ref, ref));
    if (elsewhere.length) return false;
    await tx.insert(schema.creditLedger).values({ id: ulid(), accountId, delta: usd, reason: "topup", ref });
    await tx.update(schema.apiAccounts).set({ credits: sql`${schema.apiAccounts.credits} + ${usd}::numeric` }).where(eq(schema.apiAccounts.id, accountId));
    return true;
  });
}

/** Spend `usd` of credits for one premium call. False (and nothing written) when the balance is too low. */
export async function spendCredit(db: Db, accountId: string, route: string, usd: string): Promise<boolean> {
  if (!USD_RE.test(usd) || !(Number(usd) > 0)) throw new CreditsError("spend must be a positive USD amount");
  return db.transaction(async (tx) => {
    const r = await tx
      .update(schema.apiAccounts)
      .set({ credits: sql`${schema.apiAccounts.credits} - ${usd}::numeric` })
      .where(and(eq(schema.apiAccounts.id, accountId), sql`${schema.apiAccounts.credits} >= ${usd}::numeric`))
      .returning({ id: schema.apiAccounts.id });
    if (!r.length) return false;
    await tx.insert(schema.creditLedger).values({ id: ulid(), accountId, delta: `-${usd}`, reason: "spend", ref: route });
    return true;
  });
}

/** Grant a ledger credit once per (account, ref): monthly allowances and access credits. */
export async function grantCredit(db: Db, accountId: string, usd: string, reason: string, ref: string): Promise<boolean> {
  if (!USD_RE.test(usd) || !(Number(usd) > 0)) throw new CreditsError("grant must be a positive USD amount");
  return db.transaction(async (tx) => {
    const acct = await tx.execute(sql`select id from api_accounts where id = ${accountId} for update`);
    if (!acct.length) throw new CreditsError("unknown account");
    const seen = await tx.select({ id: schema.creditLedger.id }).from(schema.creditLedger).where(and(eq(schema.creditLedger.accountId, accountId), eq(schema.creditLedger.ref, ref)));
    if (seen.length) return false;
    await tx.insert(schema.creditLedger).values({ id: ulid(), accountId, delta: usd, reason, ref });
    await tx.update(schema.apiAccounts).set({ credits: sql`${schema.apiAccounts.credits} + ${usd}::numeric` }).where(eq(schema.apiAccounts.id, accountId));
    return true;
  });
}

export async function creditsOf(db: Db, accountId: string, ledgerLimit = 50): Promise<{ credits: string; ledger: { delta: string; reason: string; ref: string | null; ts: string }[] } | null> {
  const a = await db.select().from(schema.apiAccounts).where(eq(schema.apiAccounts.id, accountId));
  if (!a[0]) return null;
  const l = await db.select().from(schema.creditLedger).where(eq(schema.creditLedger.accountId, accountId)).orderBy(desc(schema.creditLedger.ts)).limit(ledgerLimit);
  return { credits: a[0].credits, ledger: l.map((r) => ({ delta: r.delta, reason: r.reason, ref: r.ref, ts: r.ts.toISOString() })) };
}

/** The parts of the x402 after-settle context the top-up hook reads (structurally the SDK's SettleResultContext). */
export interface TopupSettleContext {
  /** Client-supplied: never read for routing or for the account (the SDK does not check resource.url). */
  paymentPayload?: unknown;
  /** Built by our resource server for the route that was really requested. */
  requirements: { network: string; asset: string; amount: string };
  result: { success: boolean; transaction: string; payer?: string };
  /** The SDK's HTTP transport context: `{ request: { path, method, adapter } }` from the request that was served. */
  transportContext?: unknown;
}

interface ServedRequest {
  path: string;
  method: string;
  account: string | null;
}

/** The request that was really served, read from the HTTP transport context (null when it is not an HTTP request). */
export function servedRequest(transportContext: unknown): ServedRequest | null {
  const req = (transportContext as { request?: unknown } | undefined)?.request as
    | { path?: unknown; method?: unknown; adapter?: { getMethod?: () => string; getQueryParam?: (n: string) => string | string[] | undefined } }
    | undefined;
  if (!req || typeof req.path !== "string") return null;
  const method = typeof req.method === "string" && req.method ? req.method : (req.adapter?.getMethod?.() ?? "");
  const q = req.adapter?.getQueryParam?.("account");
  // one value only: a repeated ?account= is refused rather than guessed
  const account = typeof q === "string" && q ? q : null;
  return { path: req.path, method: method.toUpperCase(), account };
}

const TOPUP_PATH_RE = /^\/v1\/credits\/topup\/(5|20|100)$/;

/**
 * x402 resource-server after-settle hook for the top-up routes. Register it with `rs.onAfterSettle(...)`.
 * It reads ONLY server-side facts: the path, method and `account` query parameter of the request that was really
 * served (the HTTP transport context) and the requirements our server built for that route. The client-supplied
 * `paymentPayload.resource.url` is never read: the SDK does not validate it, so trusting it would let a payment for
 * any priced route credit a top-up to an account of the caller's choice.
 * It fires only on `POST /v1/credits/topup/<pack>`, and only when the settled amount is exactly the pack price.
 * The settlement id is network + transaction, so a replay never credits twice.
 */
export function topupSettleHook(
  db: Db,
  opts: {
    log?: { warn(m: string, f?: Record<string, unknown>): void };
    /** Token decimals per (network, asset), from the token facts read at boot. Default 6 (USDC and USDG). */
    decimalsOf?: (network: string, asset: string) => number | undefined;
  } = {},
) {
  return async (ctx: TopupSettleContext): Promise<void> => {
    if (!ctx.result.success) return;
    const served = servedRequest(ctx.transportContext);
    if (!served || served.method !== "POST") return;
    const m = TOPUP_PATH_RE.exec(served.path);
    if (!m || !served.account) return;
    const pack = m[1]!;
    const decimals = opts.decimalsOf?.(ctx.requirements.network, ctx.requirements.asset) ?? 6;
    let usd: string;
    try {
      usd = atomicToUsd(ctx.requirements.amount, decimals);
    } catch {
      opts.log?.warn("credit top-up refused: bad settled amount", { account: served.account, amount: ctx.requirements.amount });
      return;
    }
    if (usd !== pack) {
      // fail closed: a settled amount that is not the pack price is never credited (logged for ops)
      opts.log?.warn("credit top-up refused: settled amount is not the pack price", { account: served.account, pack, usd });
      return;
    }
    try {
      await topUpCredits(db, served.account, {
        id: `${ctx.requirements.network}:${ctx.result.transaction}`,
        network: ctx.requirements.network,
        asset: ctx.requirements.asset,
        amount: ctx.requirements.amount,
        decimals,
        payer: ctx.result.payer ?? "",
        status: "settled",
      });
    } catch (err) {
      opts.log?.warn("credit top-up after settle failed", { err, account: served.account });
    }
  };
}

// ---- pending top-ups (security review r1 review-r1:4 F4) ----------------------------------------------------------
// A top-up whose settle comes back settlement_pending (the receipt wait timed out or the RPC failed) was charged on
// chain once the tx mined but never credited: the after-settle hook only runs on success, and the facilitator's
// reconciler only marks its own x402_payments row settled. Now the resource server's settle-failure hook records the
// served account and pack server-side as a zero-delta `topup_pending` ledger row (visible in the account's ledger),
// and the topup-reconcile job credits it exactly once when the facilitator's row for that tx turns settled.

export const TOPUP_PENDING_REASON = "topup_pending";
export const TOPUP_PENDING_FAILED_REASON = "topup_pending_failed";
/** A pending top-up still unresolved after this long raises an ops alert. */
export const TOPUP_PENDING_ALERT_MS = 10 * 60_000;
/** Pending rows older than this are no longer checked (the facilitator drops a tx it never saw after 10 minutes). */
export const TOPUP_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const PENDING_PREFIX = "x402pending:";

/** The ledger ref of a pending top-up: network, tx, atomic amount and decimals (network holds a colon). */
export const pendingTopupRef = (p: { network: string; transaction: string; amount: string; decimals: number }) => `${PENDING_PREFIX}${p.network}:${p.transaction}:${p.amount}:${p.decimals}`;

export function parsePendingTopupRef(ref: string): { network: string; transaction: string; amount: string; decimals: number } | null {
  if (!ref.startsWith(PENDING_PREFIX)) return null;
  const parts = ref.slice(PENDING_PREFIX.length).split(":");
  if (parts.length < 4) return null;
  const decimals = Number(parts.pop());
  const amount = parts.pop()!;
  const transaction = parts.pop()!;
  const network = parts.join(":");
  if (!Number.isInteger(decimals) || !/^\d{1,40}$/.test(amount) || !transaction || !/^[a-z0-9-]+:[A-Za-z0-9]+$/.test(network)) return null;
  return { network, transaction, amount, decimals };
}

/** The parts of the x402 settle-failure context the pending hook reads (structurally the SDK's SettleFailureContext). */
export interface TopupSettleFailureContext {
  requirements: { network: string; asset: string; amount: string };
  error: unknown;
  transportContext?: unknown;
}

/**
 * x402 resource-server settle-failure hook for the top-up routes. Register it with `rs.onSettleFailure(...)`.
 * Only a settlement_pending failure that names a broadcast transaction is recorded; the account and pack come from
 * the served request (never the client's resource.url) and the amount must be exactly the pack price.
 */
export function topupPendingHook(
  db: Db,
  opts: { log?: { warn(m: string, f?: Record<string, unknown>): void }; decimalsOf?: (network: string, asset: string) => number | undefined } = {},
) {
  return async (ctx: TopupSettleFailureContext): Promise<void> => {
    const e = ctx.error as { errorReason?: unknown; transaction?: unknown } | null;
    if (e?.errorReason !== "settlement_pending" || typeof e.transaction !== "string" || !/^[A-Za-z0-9]{16,128}$/.test(e.transaction)) return;
    const served = servedRequest(ctx.transportContext);
    if (!served || served.method !== "POST") return;
    const m = TOPUP_PATH_RE.exec(served.path);
    if (!m || !served.account) return;
    const decimals = opts.decimalsOf?.(ctx.requirements.network, ctx.requirements.asset) ?? 6;
    let usd: string;
    try {
      usd = atomicToUsd(ctx.requirements.amount, decimals);
    } catch {
      return;
    }
    if (usd !== m[1]) return;
    const ref = pendingTopupRef({ network: ctx.requirements.network, transaction: e.transaction, amount: ctx.requirements.amount, decimals });
    try {
      const seen = await db.select({ id: schema.creditLedger.id }).from(schema.creditLedger).where(eq(schema.creditLedger.ref, ref));
      if (!seen.length) await db.insert(schema.creditLedger).values({ id: ulid(), accountId: served.account, delta: "0", reason: TOPUP_PENDING_REASON, ref });
    } catch (err) {
      opts.log?.warn("pending top-up could not be recorded", { err, account: served.account });
    }
  };
}

export interface PendingTopupRun {
  checked: number;
  credited: number;
  failed: number;
  waiting: number;
}

/**
 * Credit pending top-ups whose payment the facilitator has since confirmed (x402_payments row for that tx settled,
 * same network and amount). Idempotent: the credit uses the after-settle hook's settlement id (network:tx), so a
 * top-up is credited once whichever path lands first. A payment that failed or was dropped is closed with a
 * zero-delta `topup_pending_failed` row and an alert; one still waiting after 10 minutes raises an alert.
 */
export async function reconcilePendingTopups(db: Db, o: { now: () => number; alert?: (a: { kind: string; [k: string]: unknown }) => Promise<void> | void; alerted?: Set<string> }): Promise<PendingTopupRun> {
  const out: PendingTopupRun = { checked: 0, credited: 0, failed: 0, waiting: 0 };
  const since = new Date(o.now() - TOPUP_PENDING_MAX_AGE_MS);
  const rows = await db
    .select()
    .from(schema.creditLedger)
    .where(and(eq(schema.creditLedger.reason, TOPUP_PENDING_REASON), gt(schema.creditLedger.ts, since)));
  for (const r of rows) {
    const p = r.ref ? parsePendingTopupRef(r.ref) : null;
    if (!p) continue;
    const creditRef = `x402:${p.network}:${p.transaction}`;
    const done = await db
      .select({ id: schema.creditLedger.id })
      .from(schema.creditLedger)
      .where(or(eq(schema.creditLedger.ref, creditRef), and(eq(schema.creditLedger.ref, r.ref!), eq(schema.creditLedger.reason, TOPUP_PENDING_FAILED_REASON))));
    if (done.length) continue;
    out.checked++;
    const [pay] = await db.select().from(schema.x402Payments).where(and(eq(schema.x402Payments.chain, p.network), eq(schema.x402Payments.txHash, p.transaction))).limit(1);
    if (pay?.status === "settled" && BigInt(pay.amount) === BigInt(p.amount)) {
      if (await topUpCredits(db, r.accountId, { id: `${p.network}:${p.transaction}`, network: p.network, asset: pay.asset, amount: p.amount, decimals: p.decimals, payer: pay.payer, status: "settled" })) out.credited++;
      continue;
    }
    if (pay && (pay.status === "failed" || pay.status === "dropped" || pay.status === "settled")) {
      // failed, dropped, or settled for another amount: never credited, closed once, ops told
      await db.insert(schema.creditLedger).values({ id: ulid(), accountId: r.accountId, delta: "0", reason: TOPUP_PENDING_FAILED_REASON, ref: r.ref });
      await o.alert?.({ kind: "x402.topup_not_credited", account: r.accountId, network: p.network, transaction: p.transaction, status: pay.status });
      out.failed++;
      continue;
    }
    out.waiting++;
    if (o.now() - r.ts.getTime() > TOPUP_PENDING_ALERT_MS && !o.alerted?.has(r.id)) {
      o.alerted?.add(r.id);
      await o.alert?.({ kind: "x402.topup_pending", account: r.accountId, network: p.network, transaction: p.transaction, sinceMs: o.now() - r.ts.getTime() });
    }
  }
  return out;
}
