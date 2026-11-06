// Postgres receipt store (todo 28): rows in `receipts`, the per-owner chain head in `receipt_heads`. Appends for one
// owner run one at a time across every process: lockOwner takes a transaction-scoped advisory lock on the owner key
// (covers the first receipt, when no head row exists yet) and then SELECT ... FOR UPDATE on the head row.
// Receipts store only the receipt body (public fields): no IP, no country, no API key.
import { schema, type Db } from "@capstan/core";
import type { Hex, Receipt } from "@capstan/schema";
import { asc, eq, sql } from "drizzle-orm";
import { byTsThenId, ownerKey, type ReceiptStore } from "../chain";
import { receiptHash } from "../hash";

/** A Drizzle database or a transaction on one. */
export type DbLike = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

/** Idempotency key of a receipt: requestHash + ":" + (buildId or "-"). */
export const idemKeyOf = (r: { requestHash: Hex; buildId: string | null }): string => `${r.requestHash.toLowerCase()}:${r.buildId ?? "-"}`;

export function pgReceiptStore(db: DbLike): ReceiptStore & {
  byIdem(key: string): Promise<Receipt | null>;
  hourOf(id: string): Promise<number | null>;
  lockOwner(owner: string): Promise<void>;
} {
  const t = schema.receipts;
  const h = schema.receiptHeads;
  return {
    async head(owner) {
      const k = ownerKey(owner);
      if (k === null) return null;
      const rows = await db.select().from(h).where(eq(h.owner, k)).limit(1);
      const row = rows[0];
      return row ? { id: row.lastReceiptId, hash: row.lastHash as Hex } : null;
    },
    async append(r, leaf, hourEpoch) {
      const k = ownerKey(r.owner);
      await db.insert(t).values({
        id: r.receiptId,
        hourEpoch,
        owner: k,
        action: r.action,
        body: r,
        leaf,
        prevHash: r.prevReceiptHash,
        ts: new Date(r.ts),
        idemKey: idemKeyOf(r),
      });
      if (k !== null) {
        const hash = receiptHash(r);
        await db
          .insert(h)
          .values({ owner: k, lastReceiptId: r.receiptId, lastHash: hash, updatedAt: new Date() })
          .onConflictDoUpdate({ target: h.owner, set: { lastReceiptId: r.receiptId, lastHash: hash, updatedAt: new Date() } });
      }
    },
    async byHour(hourEpoch) {
      const rows = await db.select({ id: t.id, leaf: t.leaf, body: t.body }).from(t).where(eq(t.hourEpoch, hourEpoch)).orderBy(asc(t.ts), asc(t.id));
      return rows.map((x) => ({ id: x.id, leaf: x.leaf as Hex, ts: (x.body as Receipt).ts })).sort(byTsThenId);
    },
    async get(id) {
      const rows = await db.select({ body: t.body }).from(t).where(eq(t.id, id)).limit(1);
      return (rows[0]?.body as Receipt | undefined) ?? null;
    },
    async byIdem(key) {
      const rows = await db.select({ body: t.body }).from(t).where(eq(t.idemKey, key)).limit(1);
      return (rows[0]?.body as Receipt | undefined) ?? null;
    },
    async hourOf(id) {
      const rows = await db.select({ hour: t.hourEpoch }).from(t).where(eq(t.id, id)).limit(1);
      return rows[0]?.hour ?? null;
    },
    async lockOwner(owner) {
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`receipt-owner:${owner}`}, 0))`);
      await db.execute(sql`select owner from receipt_heads where owner = ${owner} for update`);
    },
  };
}
