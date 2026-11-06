// Durable settle records in x402_payments. The row id is the payment key (sha256 of the canonical payment payload),
// so one payment has exactly one row. Status flow:
//   settling -> settlement_pending (hash recorded BEFORE the raw tx is sent) -> settled | failed
//   settling -> failed (refused before any broadcast; a later call may claim it again)
//   settlement_pending -> dropped (the reconciler saw no tx on chain long after; a later call may claim it again)
import { schema, type Db } from "@capstan/core";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

export type PaymentStatus = "settling" | "settlement_pending" | "settled" | "failed" | "dropped";

export interface PaymentRow {
  id: string;
  chain: string;
  asset: string;
  method: string;
  payer: string;
  amount: string;
  endpoint: string;
  txHash: string | null;
  status: PaymentStatus;
  ts: Date;
}

export type ClaimResult = { claimed: true; row: PaymentRow } | { claimed: false; row: PaymentRow };

export interface PaymentStore {
  /** Insert the row as `settling`, or re-claim a row that failed before broadcast or was dropped. Atomic. */
  claim(row: Omit<PaymentRow, "status" | "txHash">): Promise<ClaimResult>;
  markPending(id: string, txHash: string): Promise<void>;
  finish(id: string, status: Exclude<PaymentStatus, "settling" | "settlement_pending">, txHash: string | null, payer?: string): Promise<void>;
  get(id: string): Promise<PaymentRow | null>;
  /** Rows waiting for the reconciler. */
  pending(): Promise<PaymentRow[]>;
}

const RECLAIMABLE = (r: PaymentRow) => (r.status === "failed" && r.txHash === null) || r.status === "dropped";

export function memoryPaymentStore(): PaymentStore & { rows: Map<string, PaymentRow>; writes: number } {
  const rows = new Map<string, PaymentRow>();
  const s = {
    rows,
    writes: 0,
    async claim(row: Omit<PaymentRow, "status" | "txHash">): Promise<ClaimResult> {
      const cur = rows.get(row.id);
      if (cur && !RECLAIMABLE(cur)) return { claimed: false, row: { ...cur } };
      const next: PaymentRow = { ...row, status: "settling", txHash: null };
      rows.set(row.id, next);
      s.writes++;
      return { claimed: true, row: { ...next } };
    },
    async markPending(id: string, txHash: string) {
      const cur = rows.get(id);
      if (!cur) throw new Error("markPending: no row");
      rows.set(id, { ...cur, status: "settlement_pending", txHash });
      s.writes++;
    },
    async finish(id: string, status: PaymentStatus, txHash: string | null, payer?: string) {
      const cur = rows.get(id);
      if (!cur) throw new Error("finish: no row");
      rows.set(id, { ...cur, status, txHash: txHash ?? cur.txHash, payer: payer || cur.payer });
      s.writes++;
    },
    async get(id: string) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async pending() {
      return [...rows.values()].filter((r) => r.status === "settlement_pending").map((r) => ({ ...r }));
    },
  };
  return s as PaymentStore & { rows: Map<string, PaymentRow>; writes: number };
}

export function pgPaymentStore(db: Db): PaymentStore {
  const t = schema.x402Payments;
  const toRow = (r: typeof t.$inferSelect): PaymentRow => ({ ...r, status: r.status as PaymentStatus });
  return {
    async claim(row) {
      const inserted = await db
        .insert(t)
        .values({ ...row, status: "settling", txHash: null })
        .onConflictDoUpdate({
          target: t.id,
          set: { status: "settling", txHash: null, ts: row.ts },
          setWhere: or(and(eq(t.status, "failed"), isNull(t.txHash)), eq(t.status, "dropped")),
        })
        .returning();
      if (inserted[0]) return { claimed: true, row: toRow(inserted[0]) };
      const cur = await db.select().from(t).where(eq(t.id, row.id));
      if (!cur[0]) throw new Error("claim: row vanished");
      return { claimed: false, row: toRow(cur[0]) };
    },
    async markPending(id, txHash) {
      await db.update(t).set({ status: "settlement_pending", txHash }).where(eq(t.id, id));
    },
    async finish(id, status, txHash, payer) {
      await db
        .update(t)
        .set({ status, txHash: txHash ?? sql`${t.txHash}`, ...(payer ? { payer } : {}) })
        .where(eq(t.id, id));
    },
    async get(id) {
      const r = await db.select().from(t).where(eq(t.id, id));
      return r[0] ? toRow(r[0]) : null;
    },
    async pending() {
      const r = await db.select().from(t).where(inArray(t.status, ["settlement_pending"]));
      return r.map(toRow);
    },
  };
}
