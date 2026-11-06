// Aster builder-fee reconciliation (venue-aster.md section 7): `GET /fapi/v3/builder/userCommissions` for the previous
// UTC day, signed in Mode B by an agent of the builder account (weight 5, `startTime` at most 90 days back, `limit` up
// to 1000, paged until `hasMore` is false). Every row is a trade that carried our builder code; rows are matched to
// receipts on `orderId`. A row with a builder fee and no receipt is an alert; a row with `builderFee "0"` (for example a
// liquidation or ADL fill) counts as a fill with zero fee and is never an alert. Only commissions are read: builder
// reads of users' positions stay off (DECISIONS 33). The signed client runs only on the VPS (Aster lists Canada).
import type { Db } from "@capstan/core";
import { Dec, type Hex } from "@capstan/schema";
import { queryString, type DigestSigner, type Param } from "@capstan/signer-aster";
import { digestTrade } from "@capstan/signer-aster";
import type { VenueHttp } from "@capstan/venue-client";
import { alert, d, dayBounds, ordersFor, receiptsFor, receiptsWithoutFill, str, upsertAccrual, upsertFills, zero, DAY_MS, type FillRow, type Publish, type ReconReport } from "./common";

export const ASTER_COMMISSIONS_PATH = "/fapi/v3/builder/userCommissions";
export const ASTER_PAGE_LIMIT = 1000;
export const ASTER_MAX_PAGES = 1000;
export const ASTER_WINDOW_DAYS = 90;
const STABLES = new Set(["USDT", "USDC", "USD1", "USDF", "U"]);

export interface AsterCommissionRow {
  tradeId: string | number;
  insertTime: number;
  orderId: string | number;
  symbol: string;
  feeAsset: string;
  marginAsset: string;
  builderFee: string; // "0" when none
  userAddress: string;
  price?: string; // not in userCommissions; filled when a source provides it
  qty?: string;
}

export interface AsterBuilderReports {
  /** The builder account the reads are signed for (the accrual key). */
  readonly builder: Hex;
  userCommissions(startMs: number, endMs: number, page: number, limit: 1000): Promise<{ rows: AsterCommissionRow[]; hasMore: boolean }>;
}

export interface AsterReconDeps {
  db: Db;
  builderReports: AsterBuilderReports;
  publish?: Publish;
  log?: { warn(m: string, f?: Record<string, unknown>): void };
  now?: () => Date;
}

const DEC = /^-?\d+(\.\d+)?$/;

export async function reconcileAster(day: string, deps: AsterReconDeps): Promise<ReconReport> {
  const { start, end } = dayBounds(day);
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  if (nowMs - start > ASTER_WINDOW_DAYS * DAY_MS) throw new Error(`reconcile aster: ${day} is older than the ${ASTER_WINDOW_DAYS}-day window of userCommissions`);
  const rows: AsterCommissionRow[] = [];
  let hasMore = true;
  for (let page = 1; hasMore; page++) {
    if (page > ASTER_MAX_PAGES) throw new Error("reconcile aster: too many pages");
    const r = await deps.builderReports.userCommissions(start, end - 1, page, ASTER_PAGE_LIMIT);
    rows.push(...r.rows);
    hasMore = r.hasMore && r.rows.length > 0;
  }
  const report: ReconReport = { day, venue: "aster", fills: 0, notionalUsd: "0", feeUsd: "0", unmatchedFills: [], receiptsWithoutFill: [], nonUsdFeeRows: 0 };
  const valid = rows.filter((r) => r && r.tradeId !== undefined && r.orderId !== undefined && typeof r.builderFee === "string" && DEC.test(r.builderFee) && r.insertTime >= start && r.insertTime < end);
  const seen = new Set<string>();
  const unique = valid.filter((r) => {
    const k = String(r.tradeId);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const oids = [...new Set(unique.map((r) => String(r.orderId)))];
  const [orders, receipts] = await Promise.all([ordersFor(deps.db, "aster", oids), receiptsFor(deps.db, "aster", oids)]);
  const fills: FillRow[] = [];
  let fee = zero();
  let notional = zero();
  const missing: { id: string; orderId: string; builderFee: string; user: string }[] = [];
  for (const r of unique) {
    const oid = String(r.orderId);
    const id = `aster:${r.tradeId}`;
    const bf = r.builderFee;
    const px = r.price && DEC.test(r.price) ? r.price : "0";
    const sz = r.qty && DEC.test(r.qty) ? r.qty : "0";
    fills.push({ id, orderId: orders.get(oid)?.id ?? null, venue: "aster", venueOrderId: oid, px, sz, feeUsd: "0", builderFeeUsd: bf, ts: new Date(r.insertTime) });
    if (STABLES.has(r.feeAsset)) fee = Dec.add(fee, d(bf));
    else if (Dec.cmp(d(bf), zero()) !== 0) report.nonUsdFeeRows!++;
    notional = Dec.add(notional, Dec.mul(d(px), d(sz), 18));
    const hasFee = Dec.cmp(d(bf), zero()) > 0;
    if (!receipts.has(oid) && hasFee) {
      report.unmatchedFills.push(id);
      missing.push({ id, orderId: oid, builderFee: bf, user: r.userAddress });
    }
  }
  await upsertFills(deps.db, fills);
  report.fills = fills.length;
  report.feeUsd = str(fee);
  report.notionalUsd = str(notional);
  report.unmatchedFills.sort();
  await upsertAccrual(deps.db, { day, venue: "aster", builder: deps.builderReports.builder, fills: fills.length, notionalUsd: report.notionalUsd, feeUsd: report.feeUsd, unmatchedFills: report.unmatchedFills.length, source: "aster_commissions" });
  if (missing.length) await alert(deps.publish, deps.log, { day, venue: "aster", reason: "fill_without_receipt", unmatchedFills: missing.length, fills: missing.slice(0, 20) });
  report.receiptsWithoutFill = await receiptsWithoutFill(deps.db, "aster", start, end);
  if (report.receiptsWithoutFill.length) await alert(deps.publish, deps.log, { day, venue: "aster", reason: "receipt_without_fill", unmatchedFills: report.receiptsWithoutFill.length, receipts: report.receiptsWithoutFill.slice(0, 20) });
  return report;
}

/** True only on the VPS with the builder agent keystore configured (Aster's terms list Canada; README rule 8). */
export function asterReconEnabled(env: Record<string, string | undefined> = process.env): { ok: true } | { ok: false; reason: string } {
  if (env.CAPSTAN_RUNNER !== "vps") return { ok: false, reason: "aster builder reads run only on the VPS (CAPSTAN_RUNNER=vps)" };
  for (const k of ["ASTER_BUILDER_ADDRESS", "ASTER_BUILDER_AGENT_ADDRESS", "ASTER_BUILDER_AGENT_KEYSTORE", "ASTER_BUILDER_AGENT_PASSWORD_FILE"]) {
    if (!env[k]) return { ok: false, reason: `${k} is not set` };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.ASTER_BUILDER_ADDRESS!) || !/^0x[0-9a-fA-F]{40}$/.test(env.ASTER_BUILDER_AGENT_ADDRESS!)) return { ok: false, reason: "builder or agent address is not an address" };
  return { ok: true };
}

function parsePage(body: unknown): { rows: AsterCommissionRow[]; hasMore: boolean } {
  if (Array.isArray(body)) return { rows: body as AsterCommissionRow[], hasMore: body.length >= ASTER_PAGE_LIMIT };
  const b = (body ?? {}) as { rows?: unknown; data?: unknown; list?: unknown; hasMore?: unknown };
  const rows = (Array.isArray(b.rows) ? b.rows : Array.isArray(b.data) ? b.data : Array.isArray(b.list) ? b.list : null) as AsterCommissionRow[] | null;
  if (!rows) throw new Error("aster userCommissions: unexpected response shape");
  return { rows, hasMore: b.hasMore === true };
}

/**
 * The signed client (VPS only): Mode B query signed by the builder's agent. Parameter names follow the other V3
 * signed reads (asterChain, user, signer, nonce); `page` follows the builder list endpoints. VERIFY both on the VPS
 * with the first real read (BACKLOG C46).
 */
export function signedAsterBuilderReports(o: { http: VenueHttp; network: "Mainnet" | "Testnet"; builder: Hex; agent: Hex; sign: DigestSigner; nonce: () => bigint }): AsterBuilderReports {
  return {
    builder: o.builder,
    async userCommissions(startMs, endMs, page, limit) {
      const params: Param[] = [
        ["startTime", startMs],
        ["endTime", endMs],
        ["page", page],
        ["limit", limit],
        ["asterChain", o.network],
        ["user", o.builder],
        ["signer", o.agent],
        ["nonce", o.nonce()],
      ];
      const query = queryString(params);
      const signature = await o.sign(digestTrade(query, o.network === "Testnet" ? 714 : 1666));
      const raw = await o.http.request("GET", `${ASTER_COMMISSIONS_PATH}?${query}&signature=${signature}`, { cost: 5 });
      if (raw.httpStatus !== 200) throw new Error(`aster userCommissions: HTTP ${raw.httpStatus}`);
      return parsePage(raw.body);
    },
  };
}
